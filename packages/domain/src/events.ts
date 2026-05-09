import { z } from 'zod';

export const TimelineEventType = z.enum([
  // run
  'RUN_STARTED',
  'RUN_PAUSED_RATE_LIMIT',
  'RUN_PAUSED_GATE',
  'RUN_PAUSED_BUDGET',
  'RUN_RESUMED',
  'RUN_COMPLETED',
  'RUN_FAILED',
  'RUN_CANCELLED',
  // workflow
  'WORKFLOW_STARTED',
  'WORKFLOW_COMPLETED',
  // changeset
  'CHANGESET_OPENED',
  'CHANGESET_DEV_DEPLOYED',
  'CHANGESET_TESTS_PASSED',
  'CHANGESET_TESTS_FAILED',
  'CHANGESET_FLAGGED',
  'CHANGESET_PROMOTED',
  'CHANGESET_ROLLED_BACK',
  // agent
  'AGENT_STEP_STARTED',
  'AGENT_STEP_COMPLETED',
  'AGENT_STEP_FAILED',
  'AGENT_TOOL_CALL',
  'AGENT_DECISION',
  // gate
  'GATE_REACHED',
  'HUMAN_APPROVED',
  'HUMAN_REJECTED',
  // digest
  'DIGEST_DISPATCHED',
]);
export type TimelineEventType = z.infer<typeof TimelineEventType>;

export const TimelineActor = z.union([
  z.object({ kind: z.literal('agent'), id: z.string(), agentKind: z.string().optional() }),
  z.object({ kind: z.literal('user'), id: z.string() }),
  z.object({ kind: z.literal('system') }),
]);
export type TimelineActor = z.infer<typeof TimelineActor>;

export const TimelineEvent = z.object({
  id: z.string().uuid(),
  organizationId: z.string().uuid(),
  projectId: z.string().uuid(),
  dailyRunId: z.string().uuid().nullable().optional(),
  workflowRunId: z.string().uuid().nullable().optional(),
  agentStepId: z.string().uuid().nullable().optional(),
  changesetId: z.string().nullable().optional(),
  parentEventId: z.string().uuid().nullable().optional(),
  type: TimelineEventType,
  actor: TimelineActor,
  payload: z.record(z.unknown()),
  occurredAt: z.string().datetime(),
});
export type TimelineEvent = z.infer<typeof TimelineEvent>;
