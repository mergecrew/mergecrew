/**
 * AWS Fargate sandbox driver (#578).
 *
 * Each `start()` launches an ECS task on a pre-provisioned Fargate
 * cluster (see `infra/terraform/fargate-runner/`). Subsequent `exec()`
 * calls dispatch commands into the running task via the ECS
 * ExecuteCommand API (which uses an in-container SSM agent — included
 * in the supervisor's runner-* base images). `stop()` calls StopTask.
 *
 * Hardware-virt isolation via Fargate's per-task microVM. No VM
 * management on the operator's side. Documented tradeoff (RFC §5.1):
 * 30–60s cold start per task — best for projects with long-running
 * steps where the per-step overhead is amortized.
 */

import type {
  ExecOpts,
  ExecResult,
  SandboxDriver,
  SandboxHandle,
  SandboxStartOpts,
} from './types.js';
import { CONTAINER_WORKSPACE } from './docker-driver-constants.js';

export interface FargateApiClient {
  /**
   * Start a task on the configured cluster + task definition. Returns
   * the taskArn (used by exec/stop).
   */
  runTask(spec: FargateRunTaskSpec): Promise<string>;
  /** Block until the task is RUNNING, or throw on timeout. */
  waitForTaskRunning(taskArn: string, timeoutMs: number): Promise<void>;
  /**
   * Dispatch a command inside the running task. The driver wraps the
   * command in `sh -c '…'` so cwd + env take effect. Returns combined
   * stdout/stderr/exit-code; signal is null because ECS Execute
   * Command doesn't surface signals back.
   */
  executeCommand(
    taskArn: string,
    cmd: string[],
    opts: { stdin?: Buffer | string; timeoutMs?: number; signal?: AbortSignal },
  ): Promise<{ exitCode: number; stdout: string; stderr: string; timedOut: boolean }>;
  /** StopTask with the supervisor's reason string. */
  stopTask(taskArn: string, reason: string): Promise<void>;
}

export interface FargateRunTaskSpec {
  /** Task definition family or ARN. From RUNNER_FARGATE_TASK_DEFINITION. */
  taskDefinition: string;
  /** Fargate cluster name or ARN. From RUNNER_FARGATE_CLUSTER. */
  cluster: string;
  /** Private subnet IDs the task ENI lands on. From RUNNER_FARGATE_SUBNETS. */
  subnets: string[];
  /** Security groups attached to the task ENI. From RUNNER_FARGATE_SG. */
  securityGroups: string[];
  /** Tags surfaced for cost allocation + per-run filtering. */
  tags: Record<string, string>;
  /** Container-name overrides. The runner image is named `sandbox`. */
  overrides: {
    image?: string;
    command?: string[];
    environment?: Record<string, string>;
    cpu?: number;
    memoryMb?: number;
  };
  /** assignPublicIp — typically DISABLED for sandboxes. */
  assignPublicIp?: boolean;
}

export interface FargateDriverOpts {
  api: FargateApiClient;
  cluster: string;
  taskDefinition: string;
  subnets: string[];
  securityGroups: string[];
  /**
   * Default image when SandboxStartOpts.image is empty. Should be the
   * runner-polyglot image baked with the SSM agent (see
   * docs/03-infrastructure/26-runner-fargate.md § Image contract).
   */
  defaultImage?: string;
  /**
   * Cold-start ceiling. Mergecrew RFC §5.1 documents 30–60s as typical;
   * default of 120s gives headroom for image cache misses.
   */
  taskRunningTimeoutMs?: number;
  /**
   * Whether to assign a public IP. Default false — sandboxes should
   * egress through a NAT or a VPC endpoint, never via a direct IGW.
   */
  assignPublicIp?: boolean;
  logger?: {
    info: (m: string, meta?: any) => void;
    warn: (m: string, meta?: any) => void;
    error: (m: string, meta?: any) => void;
    /**
     * Cold-start metric callback (#578 AC). Fired with elapsed ms
     * between RunTask and the first time the task hit RUNNING. The
     * operator can wire this to CloudWatch / OTel / Prometheus from
     * the supervisor's metrics path.
     */
    metric?: (name: string, value: number, tags?: Record<string, string>) => void;
  };
}

interface SandboxRecord {
  taskArn: string;
  startedAt: number;
}

export class FargateDriver implements SandboxDriver {
  readonly name = 'fargate';
  private readonly api: FargateApiClient;
  private readonly cluster: string;
  private readonly taskDefinition: string;
  private readonly subnets: string[];
  private readonly securityGroups: string[];
  private readonly defaultImage?: string;
  private readonly taskRunningTimeoutMs: number;
  private readonly assignPublicIp: boolean;
  private readonly logger?: FargateDriverOpts['logger'];

  private readonly records = new Map<string, SandboxRecord>();

  constructor(opts: FargateDriverOpts) {
    this.api = opts.api;
    this.cluster = opts.cluster;
    this.taskDefinition = opts.taskDefinition;
    this.subnets = opts.subnets;
    this.securityGroups = opts.securityGroups;
    this.defaultImage = opts.defaultImage;
    this.taskRunningTimeoutMs = opts.taskRunningTimeoutMs ?? 120_000;
    this.assignPublicIp = opts.assignPublicIp ?? false;
    this.logger = opts.logger;
  }

  async start(opts: SandboxStartOpts): Promise<SandboxHandle> {
    const tags = {
      'mergecrew:run-id': opts.runId,
      'mergecrew:project-id': opts.projectId,
      'mergecrew:organization-id': opts.organizationId,
    };
    const spec: FargateRunTaskSpec = {
      taskDefinition: this.taskDefinition,
      cluster: this.cluster,
      subnets: this.subnets,
      securityGroups: this.securityGroups,
      assignPublicIp: this.assignPublicIp,
      tags,
      overrides: {
        image: opts.image ?? this.defaultImage,
        // Keep the task alive so subsequent execs land in the same
        // container. The base image runs as the sandbox user; the sleep
        // loop is unprivileged.
        command: ['sh', '-c', 'while true; do sleep 3600; done'],
        cpu: opts.resources?.cpu,
        memoryMb: opts.resources?.memoryMb,
      },
    };

    const startedAt = Date.now();
    const taskArn = await this.api.runTask(spec);
    try {
      await this.api.waitForTaskRunning(taskArn, this.taskRunningTimeoutMs);
    } catch (err) {
      await this.api.stopTask(taskArn, 'failed to reach RUNNING').catch(() => {});
      throw err;
    }
    const coldStartMs = Date.now() - startedAt;
    this.logger?.metric?.('fargate.cold_start_ms', coldStartMs, {
      runId: opts.runId,
    });
    this.logger?.info('fargate sandbox started', {
      runId: opts.runId,
      taskArn,
      coldStartMs,
    });

    this.records.set(taskArn, { taskArn, startedAt });
    return {
      id: taskArn,
      driver: this.name,
      workspacePath: CONTAINER_WORKSPACE,
    };
  }

  async exec(handle: SandboxHandle, opts: ExecOpts): Promise<ExecResult> {
    if (!this.records.has(handle.id)) {
      throw new Error(`unknown fargate sandbox handle: ${handle.id}`);
    }
    const cwd = opts.cwd
      ? this.resolveContainerPath(opts.cwd)
      : CONTAINER_WORKSPACE;
    const envExports = Object.entries(opts.env ?? {})
      .map(([k, v]) => `export ${k}=${shellEscape(v)};`)
      .join(' ');
    const cmdLine = [opts.cmd, ...opts.args].map(shellEscape).join(' ');
    const wrapped = ['sh', '-c', `cd ${shellEscape(cwd)} && ${envExports} ${cmdLine}`.trim()];
    const r = await this.api.executeCommand(handle.id, wrapped, {
      timeoutMs: opts.timeoutMs,
      signal: opts.signal,
    });
    return {
      exitCode: r.exitCode,
      stdout: r.stdout,
      stderr: r.stderr,
      timedOut: r.timedOut,
      signal: null,
    };
  }

  async readFile(handle: SandboxHandle, relPath: string): Promise<Buffer> {
    if (!this.records.has(handle.id)) {
      throw new Error(`unknown fargate sandbox handle: ${handle.id}`);
    }
    const target = this.resolveContainerPath(relPath);
    const r = await this.api.executeCommand(handle.id, ['cat', target], {});
    if (r.exitCode !== 0) {
      throw new Error(`fargate readFile failed (exit ${r.exitCode}): ${r.stderr.trim()}`);
    }
    return Buffer.from(r.stdout, 'binary');
  }

  async writeFile(handle: SandboxHandle, relPath: string, data: Buffer | string): Promise<void> {
    if (!this.records.has(handle.id)) {
      throw new Error(`unknown fargate sandbox handle: ${handle.id}`);
    }
    const target = this.resolveContainerPath(relPath);
    const stdin = Buffer.isBuffer(data) ? data : Buffer.from(data);
    const r = await this.api.executeCommand(
      handle.id,
      ['sh', '-c', `mkdir -p "$(dirname ${shellEscape(target)})" && tee ${shellEscape(target)} > /dev/null`],
      { stdin },
    );
    if (r.exitCode !== 0) {
      throw new Error(`fargate writeFile failed (exit ${r.exitCode}): ${r.stderr.trim()}`);
    }
  }

  async kill(handle: SandboxHandle, _signal?: NodeJS.Signals): Promise<void> {
    if (!this.records.has(handle.id)) return;
    await this.api.stopTask(handle.id, 'killed by supervisor').catch(() => {});
  }

  async stop(handle: SandboxHandle): Promise<void> {
    if (!this.records.has(handle.id)) return;
    await this.api.stopTask(handle.id, 'normal sandbox lifecycle end').catch(() => {});
    this.records.delete(handle.id);
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
