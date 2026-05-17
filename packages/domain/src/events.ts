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
  'CHANGESET_AUTO_PROMOTED',
  'CHANGESET_ROLLED_BACK',
  // Dropped from the promote digest (#471). Mergecrew opened a revert
  // PR on basePrBranch; the user reviews + merges it themselves.
  'CHANGESET_DROPPED',
  // Native PR review surface (#420, V2.al). Fires when the runner
  // posts the reviewer agent's verdict as a GitHub PR review and
  // (on approve) flips the draft PR to ready-for-review.
  'CHANGESET_REVIEW_POSTED',
  // agent
  'AGENT_STEP_STARTED',
  'AGENT_STEP_COMPLETED',
  'AGENT_STEP_FAILED',
  // V1.4 dead-runner recovery: emitted when the orchestrator's heartbeat
  // sweeper re-dispatches a step whose runner stopped writing heartbeats
  // (OOM kill, ECS task drain, network partition).
  'AGENT_STEP_RECOVERED',
  'AGENT_TOOL_CALL',
  'AGENT_DECISION',
  // Multi-agent (#332-#334). PLAN_PROPOSED carries the planner's
  // markdown plan; the coder consumes it. REVIEW_APPROVED /
  // REVIEW_CHANGES_REQUESTED gate the changeset before PR open.
  'PLAN_PROPOSED',
  'REVIEW_APPROVED',
  'REVIEW_CHANGES_REQUESTED',
  // Multi-agent loop-back exhaustion (#349). Fires when the reviewer
  // has requested changes more times than REVIEW_LOOP_CAP allows
  // (default 3 coder rounds). The run falls through to normal
  // workflow advance — i.e. the changeset surfaces to humans
  // unchanged, with the reviewer's last requestedChanges in the
  // payload so the human reviewer sees what the LLM reviewer flagged.
  'REVIEW_LOOP_EXHAUSTED',
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
