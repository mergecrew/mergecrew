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
  // First-run discovery (#492). The planner ran without a concrete task
  // (no queued intent, no prior changeset, no reviewer feedback) and
  // produced 3 candidate directions instead of a single plan. The
  // workflow terminates after this — the operator picks one of the
  // directions and triggers a fresh run with that direction as the
  // seed goal.
  'PLANNER_DIRECTIONS_PROPOSED',
  'REVIEW_APPROVED',
  'REVIEW_CHANGES_REQUESTED',
  // PM agent spec output (#517, V2.af roster). Fires when the PM
  // agent finishes scoping a queued intent into a structured spec.
  // Payload carries the parsed `spec` (title / motivation / scope /
  // acceptanceCriteria) and `sourceIntentId` so the UI can link back
  // to the intent that drove it. Engineer agents downstream read the
  // most recent PM_SPEC_PROPOSED in the workflow run as their input.
  'PM_SPEC_PROPOSED',
  // QA agent verdict (#520, V2.af roster). Fires after the QA stage
  // parses the engineers' changeset. Payload carries the structured
  // verdict (`tests_pass` | `tests_fail`), the one-line summary, and
  // the list of failure excerpts. The orchestrator already routes on
  // `output.verdict` (see #516 graph wiring); this event is for the
  // UI timeline + a future digest line that calls out red runs
  // without making the operator open the agent step.
  'QA_VERDICT',
  // DesignReviewer agent verdict (#522, V2.af roster). Fires after
  // the DesignReviewer stage parses the dev-deploy screenshot.
  // Payload carries the structured verdict (`looks_correct` |
  // `visual_regression`), the screenshot URL the agent captured,
  // and the list of one-line findings. The run-detail UI surfaces
  // `visual_regression` as a warning chip; `looks_correct` with a
  // single `vision not available` finding is the no-vision fallback
  // path and is rendered neutrally.
  'DESIGN_REVIEW_VERDICT',
  // Observation agent smoke report (#523, V2.af roster). Fires after
  // the Observation stage smoke-checks the dev URL. Payload carries
  // `verdict` (`healthy` | `unhealthy`), the observed HTTP status
  // code, the request latency in ms, and the list of one-line
  // findings. Unhealthy verdicts trigger a follow-up rollback intent
  // (the agent files it via the tracker skill before terminating).
  'OBSERVATION_REPORT',
  // BugTriage agent report (#524, V2.af roster). Fires after the
  // BugTriage stage scans post-deploy errors and queues intents for
  // new fingerprints. Payload carries `{ errorsScanned, intentsQueued,
  // intentIds }` so the run-detail UI can show how many follow-ups
  // were filed without joining to intent_inbox_items. Closes the
  // autonomous-improvement loop: deploy → error → queued intent →
  // tomorrow's Discovery picks it up.
  'BUG_TRIAGE_REPORT',
  // DocWriter agent report (#525, V2.af roster). Fires after the
  // DocWriter stage decides whether the run's changeset needs a
  // docs follow-up. Payload carries `{ verdict, filesChanged,
  // summary }`; verdict is `docs_updated` when files were edited
  // on a sibling commit and `no_op` when no user-facing change
  // warranted a doc update. The actual edits live on the sibling
  // commit the agent produced via `repo.write_file` —
  // ensureChangesetForCommit records that separately.
  'DOC_WRITER_REPORT',
  // Multi-agent loop-back exhaustion (#349). Fires when the reviewer
  // has requested changes more times than REVIEW_LOOP_CAP allows
  // (default 3 coder rounds). The run falls through to normal
  // workflow advance — i.e. the changeset surfaces to humans
  // unchanged, with the reviewer's last requestedChanges in the
  // payload so the human reviewer sees what the LLM reviewer flagged.
  'REVIEW_LOOP_EXHAUSTED',
  // Roster graph profile (#516). STAGE_FAILED fires when a strict-policy
  // multi-agent stage has at least one failed member after fan-in — the
  // run stops advancing and the changeset surfaces to humans. Payload
  // carries the stage name, the policy that triggered, and the count
  // breakdown so the UI can render which agent failed without separate
  // queries.
  'STAGE_FAILED',
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
