/**
 * Real `@kubernetes/client-node` adapter for the K8sDriver (#577).
 *
 * Kept in its own module so the driver itself stays unit-testable
 * against an in-memory fake. The shape of `K8sApiClient` is the seam.
 */
import { PassThrough } from 'node:stream';
import type {
  K8sApiClient,
  K8sJobSpec,
  K8sNetworkPolicySpec,
} from './k8s-driver.js';
import { SANDBOX_UID, SANDBOX_GID } from './docker-driver-constants.js';
import { CONTAINER_WORKSPACE } from './docker-driver-constants.js';

export interface K8sClientOpts {
  /** Read kubeconfig from default locations (kubeconfig file, in-cluster). */
  kubeConfigLoader?: 'default' | 'in-cluster';
}

/**
 * Construct a `K8sApiClient` against the cluster the supervisor runs in
 * (in-cluster service account) or the operator's kubeconfig. Imports
 * `@kubernetes/client-node` lazily so the package stays optional —
 * operators not on k8s never pay the dependency cost at start-up.
 */
export async function buildK8sApiClient(opts: K8sClientOpts = {}): Promise<K8sApiClient> {
  const k8s = await import('@kubernetes/client-node');
  const kc = new k8s.KubeConfig();
  if (opts.kubeConfigLoader === 'in-cluster') {
    kc.loadFromCluster();
  } else {
    kc.loadFromDefault();
  }
  const batch = kc.makeApiClient(k8s.BatchV1Api);
  const core = kc.makeApiClient(k8s.CoreV1Api);
  const net = kc.makeApiClient(k8s.NetworkingV1Api);
  const exec = new k8s.Exec(kc);

  return {
    async createJob(namespace: string, spec: K8sJobSpec): Promise<string> {
      const body = {
        apiVersion: 'batch/v1',
        kind: 'Job',
        metadata: {
          name: spec.name,
          namespace,
          labels: spec.labels,
        },
        spec: {
          backoffLimit: 0,
          ttlSecondsAfterFinished: spec.ttlSecondsAfterFinished ?? 300,
          activeDeadlineSeconds:
            spec.timeoutMs && spec.timeoutMs > 0 ? Math.ceil(spec.timeoutMs / 1000) : undefined,
          template: {
            metadata: { labels: spec.labels },
            spec: {
              restartPolicy: 'Never',
              automountServiceAccountToken: false,
              securityContext: {
                runAsUser: SANDBOX_UID,
                runAsGroup: SANDBOX_GID,
                runAsNonRoot: true,
                fsGroup: SANDBOX_GID,
                seccompProfile: { type: 'RuntimeDefault' },
              },
              containers: [
                {
                  name: 'sandbox',
                  image: spec.image,
                  command: ['sh', '-c', 'while true; do sleep 3600; done'],
                  workingDir: CONTAINER_WORKSPACE,
                  securityContext: {
                    allowPrivilegeEscalation: false,
                    readOnlyRootFilesystem: true,
                    capabilities: { drop: ['ALL'] },
                    runAsUser: SANDBOX_UID,
                    runAsGroup: SANDBOX_GID,
                    runAsNonRoot: true,
                  },
                  resources: spec.resources
                    ? {
                        limits: {
                          ...(spec.resources.cpu != null ? { cpu: String(spec.resources.cpu) } : {}),
                          ...(spec.resources.memoryMb != null
                            ? { memory: `${spec.resources.memoryMb}Mi` }
                            : {}),
                        },
                      }
                    : undefined,
                  volumeMounts: [
                    { name: 'workspace', mountPath: CONTAINER_WORKSPACE },
                    { name: 'tmp', mountPath: '/tmp' },
                    { name: 'home', mountPath: '/home/mergecrew' },
                  ],
                },
              ],
              volumes: [
                spec.workspacePvc
                  ? { name: 'workspace', persistentVolumeClaim: { claimName: spec.workspacePvc } }
                  : { name: 'workspace', emptyDir: {} },
                { name: 'tmp', emptyDir: { medium: 'Memory', sizeLimit: '512Mi' } },
                { name: 'home', emptyDir: { medium: 'Memory', sizeLimit: '512Mi' } },
              ],
            },
          },
        },
      };
      // @kubernetes/client-node 1.x: methods take a single options
      // object with named params (namespace, body) instead of
      // positional args. The response IS the body — no more `.body`.
      await batch.createNamespacedJob({ namespace, body: body as any });
      return spec.name;
    },

    async createNetworkPolicy(namespace: string, spec: K8sNetworkPolicySpec): Promise<void> {
      const body = {
        apiVersion: 'networking.k8s.io/v1',
        kind: 'NetworkPolicy',
        metadata: { name: spec.name, namespace },
        spec: {
          podSelector: { matchLabels: spec.podSelector },
          policyTypes: ['Egress', 'Ingress'],
          ingress: [],
          egress: (spec.egress ?? []).map((r) => ({
            to: [
              ...(r.toCidrs ?? []).map((c) => ({ ipBlock: { cidr: c } })),
              ...(r.toPodLabels ? [{ podSelector: { matchLabels: r.toPodLabels } }] : []),
            ],
            ports: r.ports?.map((p) => ({ protocol: p.protocol, port: p.port })),
          })),
        },
      };
      await net.createNamespacedNetworkPolicy({ namespace, body: body as any });
    },

    async waitForPodReady(
      namespace: string,
      jobName: string,
      timeoutMs: number,
    ): Promise<string> {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const r = await core.listNamespacedPod({
          namespace,
          labelSelector: `job-name=${jobName}`,
        });
        const items = (r.items ?? []) as any[];
        const ready = items.find((p) =>
          (p.status?.containerStatuses ?? []).every((c: any) => c.ready === true),
        );
        if (ready?.metadata?.name) return ready.metadata.name as string;
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
      throw new Error(`pod for job ${jobName} did not become ready within ${timeoutMs}ms`);
    },

    async execInPod(
      namespace: string,
      podName: string,
      cmd: string[],
      execOpts: { stdin?: Buffer | string; timeoutMs?: number; signal?: AbortSignal },
    ) {
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      stdout.on('data', (c: Buffer) => stdoutChunks.push(c));
      stderr.on('data', (c: Buffer) => stderrChunks.push(c));

      const stdinStream = execOpts.stdin
        ? (() => {
            const s = new PassThrough();
            s.end(typeof execOpts.stdin === 'string' ? Buffer.from(execOpts.stdin) : execOpts.stdin);
            return s;
          })()
        : null;

      let timedOut = false;
      let resolved = false;
      const result = await new Promise<{ exitCode: number; timedOut: boolean }>((resolve, reject) => {
        const timer =
          execOpts.timeoutMs && execOpts.timeoutMs > 0
            ? setTimeout(() => {
                timedOut = true;
                resolved = true;
                resolve({ exitCode: 124, timedOut: true });
              }, execOpts.timeoutMs)
            : null;
        const onAbort = () => {
          if (resolved) return;
          resolved = true;
          resolve({ exitCode: 137, timedOut: false });
        };
        if (execOpts.signal?.aborted) {
          onAbort();
          return;
        }
        execOpts.signal?.addEventListener('abort', onAbort, { once: true });
        exec
          .exec(
            namespace,
            podName,
            'sandbox',
            cmd,
            stdout,
            stderr,
            stdinStream,
            false,
            (status: any) => {
              if (resolved) return;
              resolved = true;
              if (timer) clearTimeout(timer);
              const exit = Number(status?.details?.causes?.[0]?.message ?? 0);
              resolve({ exitCode: Number.isFinite(exit) ? exit : 0, timedOut });
            },
          )
          .catch(reject);
      });

      return {
        exitCode: result.exitCode,
        timedOut: result.timedOut,
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
      };
    },

    async deleteJob(namespace: string, jobName: string): Promise<void> {
      await batch
        .deleteNamespacedJob({ name: jobName, namespace, propagationPolicy: 'Foreground' })
        .catch(() => {});
    },

    async deleteNetworkPolicy(namespace: string, name: string): Promise<void> {
      await net.deleteNamespacedNetworkPolicy({ name, namespace }).catch(() => {});
    },
  };
}
