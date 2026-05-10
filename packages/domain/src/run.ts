import { z } from 'zod';

export const DailyRunStatus = z.enum([
  'pending',
  'running',
  'paused_rate_limit',
  'paused_gate',
  'done',
  'failed',
  'cancelled',
]);
export type DailyRunStatus = z.infer<typeof DailyRunStatus>;

export const StepStatus = z.enum([
  'pending',
  'running',
  'done',
  'failed',
  'rate_limited',
  'paused_gate',
  'cancelled',
]);
export type StepStatus = z.infer<typeof StepStatus>;

export const PauseKind = z.enum(['rate_limit', 'gate', 'budget']);
export type PauseKind = z.infer<typeof PauseKind>;

export interface StepOutcome {
  kind:
    | 'completed'
    | 'rate_limited'
    | 'failed'
    | 'gated_reject'
    | 'gate_pending'
    | 'cancelled'
    | 'budget_exhausted';
  output?: unknown;
  toolCallsMade?: number;
  totalTokens?: number;
  retryAfterMs?: number;
  reason?: string;
  /**
   * Set on `gate_pending` outcomes — points at the `ApprovalRequest` row
   * the runner persisted before pausing. The orchestrator uses it to scope
   * the pause/resume to the right run and to re-dispatch the same step
   * once the human approves.
   */
  approvalId?: string;
  /**
   * Full agent message transcript, captured as serializable JSON (#4).
   * Persisted to S3 (or local fallback) by the runner via the
   * `@mergecrew/transcript-store` package. May be empty for early-failed
   * paths (policy-rejected before the first LLM call, etc).
   */
  transcript?: unknown[];
}
