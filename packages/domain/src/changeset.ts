import { z } from 'zod';

export const ChangesetStatus = z.enum([
  'proposed',
  'building',
  'testing',
  'tests_failed',
  'flagged',
  'pr_open',
  'dev_deployed',
  'awaiting_decision',
  'promoted',
  'rolled_back',
  'deferred',
  'abandoned',
]);
export type ChangesetStatus = z.infer<typeof ChangesetStatus>;

export const RiskChip = z.enum(['low', 'medium', 'high']);
export type RiskChip = z.infer<typeof RiskChip>;

export const DecisionKind = z.enum(['promote', 'rollback', 'defer']);
export type DecisionKind = z.infer<typeof DecisionKind>;

export const TestSummary = z.object({
  passed: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative().default(0),
  durationMs: z.number().nonnegative().default(0),
  suites: z
    .array(
      z.object({
        name: z.string(),
        passed: z.number().int().nonnegative(),
        failed: z.number().int().nonnegative(),
      }),
    )
    .default([]),
});
export type TestSummary = z.infer<typeof TestSummary>;
