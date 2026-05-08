# Workflow engine

The orchestrator coordinates DailyRuns, WorkflowRuns, and AgentSteps. It is the durable spine that survives crashes and rate-limit pauses.

## Requirements

- **Durable.** Persist every state transition; resume cleanly after process restart.
- **Long-lived.** A single DailyRun can span 12+ hours.
- **Pausable.** Rate-limit waits (minutes) and human gates (hours/days) are first-class.
- **Idempotent dispatch.** Re-dispatching a step due to retry must not double-execute side effects.
- **Multi-tenant fair.** Tenant A's slow run does not delay tenant B's fast run.
- **Observable.** Every transition emits a TimelineEvent.

## Implementation: custom durable engine on Postgres + BullMQ

Mergecrew runs a custom durable engine on Postgres + BullMQ — not Temporal. Reasoning:

- Temporal adds an operational footprint (a cluster, a UI, separate auth, another thing to monitor).
- Mergecrew's workflow set is small and stable enough that a hand-rolled state machine on Postgres is straightforward and well-bounded.
- Switching to Temporal later is feasible because the public surface (`OrchestratorClient`) is the same. See "Migration path to Temporal" below.

## State stores

- **`daily_runs.status`** — canonical run state via the `daily_run_status` enum (`pending` | `running` | `paused_rate_limit` | `paused_gate` | `done` | `failed` | `cancelled`).
- **`workflow_runs`** and **`agent_steps`** — per-workflow and per-step status, attempt counters, started/finished timestamps.
- **BullMQ queues (Redis)** — work distribution: `run.due`, `orchestrator.dispatch`, `orchestrator.rate-limit.resume`, `orchestrator.gate.resume`, `orchestrator.step-reply`, `runner.step`, `webhook.inbound`.
- **`run_pauses`** — one row per pause, distinguished by `kind` (`rate_limit` | `gate`). Rate-limit rows carry `wake_at`; gate rows carry `approval_request_id`.
- **`timeline_events`** — append-only log; the source of truth for "what happened."

## State machine semantics

A `DailyRun` is a graph of `WorkflowRun`s, themselves graphs of `AgentStep`s. The orchestrator reasons in terms of:

- A run has a set of **active fronts** — the leaves it's currently advancing.
- Each front is one of:
  - `step_in_flight(step_id)` — dispatched to a runner, awaiting outcome.
  - `step_pending(step_id)` — ready to dispatch, waiting on a runner slot.
  - `gate_pending(approval_request_id)` — awaiting a human decision.
  - `rate_limit_pending(step_id, wake_at)` — paused on a `run_pauses(kind='rate_limit')` row.
- Step outcomes are received via the `orchestrator.step-reply` queue.

## Dispatch loop

The orchestrator at `apps/orchestrator/src/orchestrator.ts` is event-driven, not a polling loop:

- `handleRunDue` — a `run.due` job fires (from cron or manual trigger); the orchestrator finds the project's latest lifecycle, creates a `daily_runs` row in `running`, emits `RUN_STARTED`, and starts the first workflow.
- `startWorkflow` → `dispatchAgentStep` — for each agent in the workflow, the orchestrator inserts a pending `agent_steps` row and enqueues a `runner.step` job.
- `onStepReply` — runners push outcomes onto `orchestrator.step-reply`. Outcomes are typed: `completed`, `failed`, `rate_limited`, `gated_reject`, `cancelled`, `budget_exhausted`. Each outcome updates the step row, emits a `TimelineEvent`, and (for terminal outcomes) calls `maybeAdvanceWorkflow` to either fan out to the next workflow or complete the run.
- `resumeRateLimit` / `resumeGate` — wake-up jobs flip the run's status back to `running`, mark the matching `run_pauses` row as resumed, and re-enqueue the same step.

There is no separate "scan the rate-limit table" tick: rate-limit pauses self-schedule a delayed BullMQ job at `now + retryAfterMs + jitter` directly from `onStepReply`.

## Idempotency

- Every step has a stable `step_id`.
- Every tool call records a `tool_call_id` derived from `(step_id, sequence)`.
- VCS adapter operations are idempotent by content: writing a file with the same hash twice is a no-op; opening a PR with the same branch+title returns the existing PR.
- Deploy adapter triggers carry a `correlation_id` so re-trigger after a crash returns the existing in-flight workflow run instead of starting a duplicate.

## Crash & restart

- Runner crash mid-step: BullMQ's job-attempts plus the runner-side retry policy re-deliver the step. The step's prior partial work in the workspace is discarded; the step starts from its persisted input.
- Orchestrator crash: state is in Postgres and the BullMQ queues. On restart, the orchestrator process re-attaches to the queues and resumes from where the queues left off. The orchestrator runs as a single process — there is no leader election.

## Rate-limit pause/resume

When a runner returns `rate_limited` (see `onStepReply` in `orchestrator.ts`):

1. Orchestrator inserts a `run_pauses` row with `kind='rate_limit'`, `step_id`, and `wake_at = now + retryAfterMs + jitter(0..30s)`.
2. The `daily_runs.status` flips to `paused_rate_limit` and a `RUN_PAUSED_RATE_LIMIT` event is emitted.
3. A delayed BullMQ job is added to `orchestrator.rate-limit.resume` at the same `wake_at`.
4. At wake time, `resumeRateLimit` flips the run back to `running`, marks the `run_pauses` row resumed, and re-enqueues the step on `runner.step`.

Backoff: `baseBackoff(attempts) = min(60s * 2^attempts, 30m)`. With `Retry-After`, we use the larger of the two.

## Gate pause/resume

When a transition with `require-approval` is reached:

1. Orchestrator creates an `approval_requests` row.
2. Inserts a `run_pauses` row with `kind='gate'`, `approval_request_id` set.
3. Notifies the configured human channel (inbox; Slack DM and email are Planned).
4. The run's other fronts continue.
5. When a user decides, the API enqueues `orchestrator.gate.resume`.
6. `resumeGate` marks the matching `run_pauses` row resumed and flips the run back to `running` so dispatch can continue.

## Cancellation

A user can cancel a DailyRun:

- API writes `RUN_CANCELLED` event and signals the orchestrator.
- Orchestrator marks the run cancelled, broadcasts an `AbortSignal` to every active runner with a step in this run.
- Runners abort current work, return `cancelled` outcomes.
- Cleanups: workspaces deleted, in-flight PRs left alone (the user can decide to keep or close them via the UI).

## Schedules

- One row per project in `schedules`: cron expression, timezone, enabled flag.
- A small `worker-cron` process scans schedules every minute and emits `RunDueEvent`s for projects whose next-fire-time has passed.
- The orchestrator consumes `RunDueEvent`s and creates a fresh `DailyRun` if no run is in-flight for that project.
- "Run now" is the same path with an immediate `RunDueEvent`.

## Per-changeset sub-runs

Each Changeset is a sub-graph anchored at a PM-produced spec. Implementation-wise, the orchestrator models a Changeset as a child workflow:

- Spawn one child WorkflowRun per intent at the PM step.
- Children run in parallel up to a per-run concurrency cap (default 4).
- Each child's failure is isolated; the parent run continues.

## Bounded parallelism

- Worker concurrency is set per BullMQ worker in `apps/orchestrator/src/main.ts` (e.g., `runner.step` and `orchestrator.step-reply` at higher concurrency than `run.due`).
- Per-org concurrency caps, BullMQ tenant-priority interleaving, and dead-runner heartbeat recovery are not implemented; if and when they're needed they belong in the multi-tenancy quota layer.

## Why not just BullMQ alone

BullMQ is a queue; it doesn't model workflow state (the graph, the gates, the partial recovery). The orchestrator's job is the graph; BullMQ is its work-distribution mechanism. Postgres holds canonical state; BullMQ's queue is regenerated from Postgres on startup if needed.

## Migration path to Temporal (forward-looking — not implemented)

If a future iteration chooses Temporal:

- `DailyRun` becomes a Temporal Workflow.
- `WorkflowRun` and `Changeset` become child workflows.
- `AgentStep` becomes an activity.
- A gate pause becomes `await Workflow.signal('HumanDecision')`.
- A rate-limit pause becomes `Workflow.sleep(retryAfter)`.

The current internal abstractions (OrchestratorClient API, AgentStep contract, Runner protocol) are designed to make this swap feasible without API churn for the rest of the system. This is a forward-looking note, not a planned migration.
