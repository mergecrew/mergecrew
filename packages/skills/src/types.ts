import type { SideEffectClass } from '@mergecrew/domain';

export type SkillCapability =
  | 'fs.read'
  | 'fs.write'
  | 'git.read'
  | 'git.write'
  | 'git.commit'
  | 'net.outbound'
  | 'process.spawn'
  | 'deploy.trigger'
  | 'deploy.read'
  | 'tracker.read'
  | 'tracker.write'
  | 'comms.write'
  | 'memory.read'
  | 'memory.write'
  | 'llm.chat';

export interface SkillExecutionContext {
  organizationId: string;
  projectId: string;
  runId?: string;
  changesetId?: string;
  agentStepId?: string;
  workspacePath?: string;
  abortSignal: AbortSignal;
  logger: { info: (m: string, meta?: any) => void; warn: (m: string, meta?: any) => void; error: (m: string, meta?: any) => void };
  emit?: (kind: string, payload: Record<string, unknown>) => Promise<void>;
  /** Adapters injected at construction time. */
  adapters: SkillAdapters;
  /** Per-skill instance config (e.g., deploy adapter id, GH workflow filename). */
  config?: Record<string, unknown>;
}

export interface SkillAdapters {
  vcs?: import('@mergecrew/adapters-vcs').VcsProvider;
  deploy?: import('@mergecrew/adapters-deploy').DeployProvider;
  tracker?: import('@mergecrew/adapters-tracker').TrackerProvider;
  comms?: import('@mergecrew/adapters-comms').CommsProvider;
}

export interface SkillResult<T = unknown> {
  output: T;
  brief: string;
}

export interface SkillDefinition<I = unknown, O = unknown> {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  sideEffectClass: SideEffectClass;
  capabilities: SkillCapability[];
  /** Default timeout in ms; can be overridden per call. */
  timeoutMs?: number;
  execute: (input: I, ctx: SkillExecutionContext) => Promise<SkillResult<O>>;
}

export type AnySkill = SkillDefinition<any, any>;
