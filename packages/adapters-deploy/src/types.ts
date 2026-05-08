export type DeployTargetKind = 'dev' | 'staging' | 'prod';

export interface DeployTargetRef {
  id: string;
  kind: DeployTargetKind;
  adapterId: string;
  config: Record<string, unknown>;
}

export interface DeployOpts {
  ref: string;
  branch: string;
  envOverrides?: Record<string, string>;
  correlationId: string;
}

export interface DeployHandle {
  externalRunId: string;
  targetId: string;
  correlationId: string;
}

export type DeployStatus =
  | { kind: 'queued' }
  | { kind: 'in_progress'; pct?: number; latestStep?: string }
  | { kind: 'success'; url: string; finishedAt: string }
  | { kind: 'failed'; reason: string; url?: string; finishedAt: string }
  | { kind: 'cancelled' };

export interface DeployResult {
  status: DeployStatus;
  url?: string;
}

export interface LogChunk {
  ts: string;
  line: string;
  step?: string;
}

export interface DeployProvider {
  readonly id: 'github-actions' | 'vercel' | 'aws-direct' | 'fly' | 'render';

  triggerDeploy(target: DeployTargetRef, opts: DeployOpts): Promise<DeployHandle>;
  getStatus(handle: DeployHandle): Promise<DeployStatus>;
  awaitCompletion(handle: DeployHandle, timeoutMs: number, abort: AbortSignal): Promise<DeployResult>;

  resolveUrlForRef(target: DeployTargetRef, ref: string): Promise<string | null>;
  fetchLogs(handle: DeployHandle, opts: { sinceMs?: number; tailLines?: number }): Promise<LogChunk[]>;

  rollbackProduction(target: DeployTargetRef, toRef: string): Promise<DeployHandle>;
}
