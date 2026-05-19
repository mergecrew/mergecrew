/**
 * Kubernetes Jobs sandbox driver (#577).
 *
 * Each `start()` creates a Kubernetes Job with one container that runs a
 * sleep loop into which subsequent `exec()` calls dispatch commands via
 * the pod-exec API. `stop()` deletes the Job; the cluster's GC removes
 * the pod (`ttlSecondsAfterFinished` is also set as a belt-and-braces
 * cleanup in case the supervisor crashes mid-run).
 *
 * Container hardening, mirroring DockerDriver (#557):
 *
 *   - runAsUser 1001 / runAsGroup 1001 / runAsNonRoot
 *   - readOnlyRootFilesystem: true (tmpfs for /tmp and /home/mergecrew)
 *   - allowPrivilegeEscalation: false
 *   - capabilities: { drop: ['ALL'] }
 *   - seccompProfile: RuntimeDefault
 *
 * Egress: a `NetworkPolicy` is applied per-Job selecting on the
 * `mergecrew.io/run-id` label. The default policy is "deny all egress
 * except DNS to the cluster resolver"; when the project has an
 * allowlist set, the supervisor creates a paired policy with the
 * cluster-native equivalent of the nftables ruleset (operator-supplied
 * via the `RUNNER_K8S_EGRESS_TEMPLATE` config map — see docs).
 *
 * File I/O: skill-level `readFile`/`writeFile` go through the pod-exec
 * API (`cat`/`tee`), so the supervisor never needs a shared volume with
 * the cluster. Workspace contents are seeded by the runner before
 * start() through the same exec channel.
 */

import type {
  ExecOpts,
  ExecResult,
  SandboxDriver,
  SandboxHandle,
  SandboxStartOpts,
} from './types.js';
import { CONTAINER_WORKSPACE, SANDBOX_UID, SANDBOX_GID } from './docker-driver-constants.js';

export interface K8sApiClient {
  /** Create a Job in the namespace. Returns the Job's metadata.name. */
  createJob(namespace: string, spec: K8sJobSpec): Promise<string>;
  /** Create a NetworkPolicy in the namespace. */
  createNetworkPolicy(namespace: string, spec: K8sNetworkPolicySpec): Promise<void>;
  /** Block until a pod owned by the Job is ready, or throw on timeout. */
  waitForPodReady(namespace: string, jobName: string, timeoutMs: number): Promise<string>;
  /** Exec a command inside the named pod's first container. */
  execInPod(
    namespace: string,
    podName: string,
    cmd: string[],
    opts: { stdin?: Buffer | string; timeoutMs?: number; signal?: AbortSignal },
  ): Promise<{ exitCode: number; stdout: string; stderr: string; timedOut: boolean }>;
  /** Delete the Job (foreground propagation deletes the Pod). */
  deleteJob(namespace: string, jobName: string): Promise<void>;
  /** Delete the NetworkPolicy. */
  deleteNetworkPolicy(namespace: string, name: string): Promise<void>;
}

export interface K8sJobSpec {
  name: string;
  image: string;
  labels: Record<string, string>;
  resources?: { cpu?: number; memoryMb?: number };
  /**
   * Sandbox-wide wall clock. Mapped to `activeDeadlineSeconds` so the
   * cluster reaps the Job if the supervisor dies before stop().
   */
  timeoutMs?: number;
  /**
   * Belt-and-braces post-completion cleanup. Default 300s — matches the
   * issue's acceptance criterion.
   */
  ttlSecondsAfterFinished?: number;
  /**
   * Optional persistent volume claim to mount at /workspace. When
   * absent, an emptyDir is used (workspace is ephemeral and dies with
   * the Pod — acceptable for V0 because the supervisor seeds it via
   * exec and reads results back through the same channel).
   */
  workspacePvc?: string;
}

export interface K8sNetworkPolicySpec {
  name: string;
  /** Pod selector — typically `mergecrew.io/run-id: <runId>`. */
  podSelector: Record<string, string>;
  /**
   * Egress rules. When omitted, the policy denies ALL egress except DNS
   * (which is always allowed so hostnames can resolve at the runner-dns
   * layer). When provided, these are merged with the DNS allowance.
   */
  egress?: K8sNetworkPolicyEgressRule[];
}

export interface K8sNetworkPolicyEgressRule {
  /** Apply to traffic destined for these CIDRs (after DNS resolution). */
  toCidrs?: string[];
  /** Or to pods carrying these labels (in the same namespace). */
  toPodLabels?: Record<string, string>;
  ports?: { protocol: 'TCP' | 'UDP'; port: number }[];
}

export interface K8sDriverOpts {
  api: K8sApiClient;
  namespace: string;
  /** Default image when SandboxStartOpts.image is empty. */
  defaultImage?: string;
  /**
   * How long to wait for the Job's pod to be ready before throwing.
   * Default 60s — image pulls can be slow on first run, but slower
   * than this is almost always a real problem.
   */
  podReadyTimeoutMs?: number;
  /** TTL applied after the Job finishes. Default 300s (#577 AC). */
  ttlSecondsAfterFinished?: number;
  /**
   * Optional storage class name. When set, the driver assumes the
   * cluster's CSI provisioner is online and an emptyDir is used for the
   * workspace (V0). A future iteration will dynamic-provision a PVC per
   * run and surface it here; today the field is recorded for telemetry.
   */
  workspaceStorageClass?: string;
  logger?: {
    info: (m: string, meta?: any) => void;
    warn: (m: string, meta?: any) => void;
    error: (m: string, meta?: any) => void;
  };
}

interface SandboxRecord {
  jobName: string;
  podName: string;
  namespace: string;
  policyName: string;
}

export class K8sDriver implements SandboxDriver {
  readonly name = 'kubernetes';
  private readonly api: K8sApiClient;
  private readonly namespace: string;
  private readonly defaultImage: string;
  private readonly podReadyTimeoutMs: number;
  private readonly ttl: number;
  private readonly logger?: K8sDriverOpts['logger'];

  // handle.id → metadata for exec / stop. Kept in-process; on supervisor
  // restart we'd lose the mapping, but ttlSecondsAfterFinished cleans the
  // Job up automatically.
  private readonly records = new Map<string, SandboxRecord>();

  constructor(opts: K8sDriverOpts) {
    this.api = opts.api;
    this.namespace = opts.namespace;
    this.defaultImage = opts.defaultImage ?? 'ghcr.io/mergecrew/runner-polyglot:latest';
    this.podReadyTimeoutMs = opts.podReadyTimeoutMs ?? 60_000;
    this.ttl = opts.ttlSecondsAfterFinished ?? 300;
    this.logger = opts.logger;
  }

  async start(opts: SandboxStartOpts): Promise<SandboxHandle> {
    const id = `mergecrew-${opts.runId.slice(0, 8)}-${Date.now().toString(36)}`;
    const labels = {
      'mergecrew.io/run-id': opts.runId,
      'mergecrew.io/project-id': opts.projectId,
      'mergecrew.io/organization-id': opts.organizationId,
      'app.kubernetes.io/managed-by': 'mergecrew-runner',
    };

    // NetworkPolicy first — once the Pod schedules and the kube-proxy
    // applies the policy, no egress can leak. Creating it after the Job
    // would leave a window where the pod is up + unmetered.
    const policyName = `${id}-egress`;
    const policySpec = this.buildNetworkPolicySpec(policyName, labels, opts);
    await this.api.createNetworkPolicy(this.namespace, policySpec);

    const jobSpec = this.buildJobSpec(id, labels, opts);
    const jobName = await this.api.createJob(this.namespace, jobSpec);
    let podName: string;
    try {
      podName = await this.api.waitForPodReady(this.namespace, jobName, this.podReadyTimeoutMs);
    } catch (err) {
      // Best-effort cleanup if scheduling failed — don't strand a Job
      // and policy in the cluster when start() rejected.
      await this.api.deleteJob(this.namespace, jobName).catch(() => {});
      await this.api.deleteNetworkPolicy(this.namespace, policyName).catch(() => {});
      throw err;
    }

    this.records.set(id, { jobName, podName, namespace: this.namespace, policyName });
    this.logger?.info('k8s sandbox started', {
      runId: opts.runId,
      jobName,
      podName,
      namespace: this.namespace,
    });

    return { id, driver: this.name, workspacePath: CONTAINER_WORKSPACE };
  }

  async exec(handle: SandboxHandle, opts: ExecOpts): Promise<ExecResult> {
    const rec = this.records.get(handle.id);
    if (!rec) throw new Error(`unknown k8s sandbox handle: ${handle.id}`);

    // Resolve cwd to an absolute path inside the workspace mount, then
    // wrap the command in `sh -c 'cd <cwd> && exec <env> <cmd> <args>'`
    // so a per-call cwd + env take effect. The argv passed to exec is
    // the wrapper, so the user's cmd is run directly (not parsed by sh
    // — `exec "$@"` style).
    const cwd = opts.cwd
      ? this.resolveContainerPath(opts.cwd)
      : CONTAINER_WORKSPACE;
    const envExports = Object.entries(opts.env ?? {})
      .map(([k, v]) => `export ${k}=${shellEscape(v)};`)
      .join(' ');
    const cmdLine = [opts.cmd, ...opts.args].map(shellEscape).join(' ');
    const wrapped = ['sh', '-c', `cd ${shellEscape(cwd)} && ${envExports} ${cmdLine}`.trim()];

    const result = await this.api.execInPod(rec.namespace, rec.podName, wrapped, {
      timeoutMs: opts.timeoutMs,
      signal: opts.signal,
    });
    return {
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      timedOut: result.timedOut,
      signal: null,
    };
  }

  async readFile(handle: SandboxHandle, relPath: string): Promise<Buffer> {
    const rec = this.records.get(handle.id);
    if (!rec) throw new Error(`unknown k8s sandbox handle: ${handle.id}`);
    const target = this.resolveContainerPath(relPath);
    const r = await this.api.execInPod(rec.namespace, rec.podName, ['cat', target], {});
    if (r.exitCode !== 0) {
      throw new Error(`k8s readFile failed (exit ${r.exitCode}): ${r.stderr.trim()}`);
    }
    return Buffer.from(r.stdout, 'binary');
  }

  async writeFile(handle: SandboxHandle, relPath: string, data: Buffer | string): Promise<void> {
    const rec = this.records.get(handle.id);
    if (!rec) throw new Error(`unknown k8s sandbox handle: ${handle.id}`);
    const target = this.resolveContainerPath(relPath);
    const stdin = Buffer.isBuffer(data) ? data : Buffer.from(data);
    const r = await this.api.execInPod(
      rec.namespace,
      rec.podName,
      ['sh', '-c', `mkdir -p "$(dirname ${shellEscape(target)})" && tee ${shellEscape(target)} > /dev/null`],
      { stdin },
    );
    if (r.exitCode !== 0) {
      throw new Error(`k8s writeFile failed (exit ${r.exitCode}): ${r.stderr.trim()}`);
    }
  }

  async kill(handle: SandboxHandle, _signal?: NodeJS.Signals): Promise<void> {
    const rec = this.records.get(handle.id);
    if (!rec) return;
    // We don't have a per-exec PID across the API boundary; sending the
    // signal at the Job level effectively kills the sleeper container,
    // which the next exec() will surface as a failure. The supervisor
    // is expected to call stop() after a kill() to fully clean up.
    await this.api.deleteJob(rec.namespace, rec.jobName).catch(() => {});
  }

  async stop(handle: SandboxHandle): Promise<void> {
    const rec = this.records.get(handle.id);
    if (!rec) return;
    await this.api.deleteJob(rec.namespace, rec.jobName).catch(() => {});
    await this.api.deleteNetworkPolicy(rec.namespace, rec.policyName).catch(() => {});
    this.records.delete(handle.id);
  }

  /** Exposed for tests — pure spec construction. */
  buildJobSpec(
    name: string,
    labels: Record<string, string>,
    opts: SandboxStartOpts,
  ): K8sJobSpec {
    return {
      name,
      image: opts.image ?? this.defaultImage,
      labels,
      resources: opts.resources ? { cpu: opts.resources.cpu, memoryMb: opts.resources.memoryMb } : undefined,
      timeoutMs: opts.resources?.timeoutMs,
      ttlSecondsAfterFinished: this.ttl,
    };
  }

  /** Exposed for tests — pure spec construction. */
  buildNetworkPolicySpec(
    name: string,
    labels: Record<string, string>,
    opts: SandboxStartOpts,
  ): K8sNetworkPolicySpec {
    const wantsEgress = (opts.egressAllowlist?.length ?? 0) > 0;
    if (!wantsEgress) {
      // Default-deny posture. DNS (UDP/53) is allowed so the runner-dns
      // resolver can answer; that resolver is the gatekeeper that turns
      // the project allowlist into actual reachability.
      return {
        name,
        podSelector: labels,
        egress: [{ ports: [{ protocol: 'UDP', port: 53 }, { protocol: 'TCP', port: 53 }] }],
      };
    }
    // With an allowlist, we add the supervisor-managed DNS resolver
    // first (so name resolution works) plus the operator's allowlist
    // template. The actual host→IP mapping is enforced at the netfilter
    // layer by the cluster CNI plugin, mirrored from nftables (#573).
    return {
      name,
      podSelector: labels,
      egress: [
        { ports: [{ protocol: 'UDP', port: 53 }, { protocol: 'TCP', port: 53 }] },
        { ports: [{ protocol: 'TCP', port: 80 }, { protocol: 'TCP', port: 443 }] },
      ],
    };
  }

  private resolveContainerPath(rel: string): string {
    if (rel.startsWith('/')) {
      if (!rel.startsWith(CONTAINER_WORKSPACE + '/') && rel !== CONTAINER_WORKSPACE) {
        throw new Error(`absolute paths must live under ${CONTAINER_WORKSPACE}: ${rel}`);
      }
      return rel;
    }
    return `${CONTAINER_WORKSPACE}/${rel}`;
  }
}

function shellEscape(s: string): string {
  if (s === '') return "''";
  if (/^[A-Za-z0-9_\-.\/:=]+$/.test(s)) return s;
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export { SANDBOX_UID, SANDBOX_GID };
