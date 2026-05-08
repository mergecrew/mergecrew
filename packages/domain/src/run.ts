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
  'cancelled',
]);
export type StepStatus = z.infer<typeof StepStatus>;

export const PauseKind = z.enum(['rate_limit', 'gate', 'budget']);
export type PauseKind = z.infer<typeof PauseKind>;

export interface StepOutcome {
  kind: 'completed' | 'rate_limited' | 'failed' | 'gated_reject' | 'cancelled' | 'budget_exhausted';
  output?: unknown;
  toolCallsMade?: number;
  totalTokens?: number;
  retryAfterMs?: number;
  reason?: string;
}
