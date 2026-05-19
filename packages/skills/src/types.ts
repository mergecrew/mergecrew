import type { SideEffectClass } from '@mergecrew/domain';
import type { SandboxDriver, SandboxHandle } from '@mergecrew/sandbox-driver';

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
  | 'llm.chat'
  | 'changeset.write';

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
  /**
   * Egress host allowlist (#10). When present, web/http skills must
   * call `assertEgressAllowed()` on the target URL before fetching.
   * Undefined = no restriction (back-compat); empty array = block all;
   * see `egress-policy.ts` for the matching rules.
   */
  egressAllowlist?: string[] | null;
  /**
   * Sandbox driver for shell execution and workspace file I/O. The runner
   * supervisor builds this once at startup (see RUNNER_SANDBOX env) and
   * threads it through every skill execution. Shell-based skills
   * (`build.*`, `repo.git.*`) will migrate to `driver.exec()` in #560 —
   * until then this field is plumbed but unused by stock skills.
   * Optional for backwards-compat with tests that build a context by hand.
   */
  driver?: SandboxDriver;
  /**
   * Per-step sandbox handle returned by `driver.start()`. Skills exec
   * commands inside this handle's scope. Same #560 caveat.
   */
  sandbox?: SandboxHandle;
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
