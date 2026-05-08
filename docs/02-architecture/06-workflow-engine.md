# Workflow engine

The orchestrator coordinates DailyRuns, WorkflowRuns, and AgentSteps. It is the durable spine that survives crashes and rate-limit pauses.

## Requirements

- **Durable.** Persist every state transition; resume cleanly after process restart.
- **Long-lived.** A single DailyRun can span 12+ hours.
- **Pausable.** Rate-limit waits (minutes) and human gates (hours/days) are first-class.
- **Idempotent dispatch.** Re-dispatching a step due to retry must not double-execute side effects.
- **Multi-tenant fair.** Tenant A's slow run does not delay tenant B's fast run.
- **Observable.** Every transition emits a TimelineEvent.

## V1 implementation: custom durable engine on Postgres + BullMQ

We don't run Temporal in V1. Reasoning:

- Temporal adds an operational footprint (a cluster, a UI, separate auth, another thing to monitor).
- Mergecrew's workflow set is small and stable enough that a hand-rolled state machine on Postgres is straightforward and well-bounded.
- Switching to Temporal later is feasible because the public surface (`OrchestratorClient`) is the same.

If the custom engine starts looking like a poor Temporal, V2 migrates.

## State stores

- **`run_state`** — one row per active `DailyRun`, with the canonical run state.
- **`step_dispatch`** — work queue of pending step dispatches, claimed by runners. Backed by BullMQ (Redis); rows mirrored into Postgres for audit.
- **`gate_wait`** — rows for runs paused on human gates.
- **`rate_limit_wait`** — rows for runs paused on provider rate limits, with `wake_at`.
- **`timeline_events`** — append-only log; the source of truth for "what happened."

## State machine semantics

A `DailyRun` is a graph of `WorkflowRun`s, themselves graphs of `AgentStep`s. The orchestrator reasons in terms of:

- A run has a set of **active fronts** — the leaves it's currently advancing.
- Each front is one of:
  - `step_in_flight(step_id)` — dispatched to a runner, awaiting outcome.
  - `step_pending(step_id)` — ready to dispatch, waiting on a runner slot.
  - `gate_pending(gate_id)` — awaiting a human decision.
  - `rate_limit_pending(step_id, wake_at)` — paused.
- Step outcomes are received via the orchestrator's inbox (a queue read).

## Dispatch loop

```
loop:
  receive outcome from runners (blocking up to 1s)
  for each outcome:
    persist outcome
    advance state machine
    enqueue any new pending steps to BullMQ
  scan rate_limit_wait where wake_at <= now()
    move them to step_pending and enqueue
  emit any new TimelineEvents
```

Concurrency control:
- Per-org concurrency caps applied at enqueue time (not at dispatch).
- BullMQ priority used to interleave tenants fairly (round-robin across orgs with active runs).

## Idempotency

- Every step has a stable `step_id`.
- Every tool call records a `tool_call_id` derived from `(step_id, sequence)`.
- VCS adapter operations are idempotent by content: writing a file with the same hash twice is a no-op; opening a PR with the same branch+title returns the existing PR.
- Deploy adapter triggers carry a `correlation_id` so re-trigger after a crash returns the existing in-flight workflow run instead of starting a duplicate.

## Crash & restart

- Runner crash mid-step: the orchestrator detects via dispatch timeout (default 15m of no heartbeat) and re-enqueues the same step. The step's prior partial work in the workspace is discarded; the step starts from its persisted input.
- Orchestrator crash: state is in Postgres; on startup, a leader-elected orchestrator process replays unfinished runs by reading `run_state` and reconstituting active fronts.

## Rate-limit pause/resume

When a runner returns `rate_limited`:

1. Orchestrator inserts a `rate_limit_wait` row: `(run_id, step_id, provider_id, wake_at)`.
2. `wake_at = now + max(retryAfter, baseBackoff(attempts)) + jitter(0..30s)`.
3. Other fronts of the same run continue dispatching (the run as a whole is not paused if other branches don't depend on this step).
4. At wake time, the orchestrator re-enqueues the step. Same step, same input.

Backoff: `baseBackoff(attempts) = min(60s * 2^attempts, 30m)`. With `Retry-After`, we use the larger of the two.

## Gate pause/resume

When a transition with `require-approval` is reached:

1. Orchestrator creates an `ApprovalRequest`.
2. Inserts a `gate_wait` row.
3. Notifies the configured human channel (Slack DM, email, inbox).
4. The run's other fronts continue.
5. When a user decides, the API writes a `Decision` and signals the orchestrator (`HUMAN_APPROVED` / `HUMAN_REJECTED`).
6. Orchestrator pops the `gate_wait`, advances the workflow accordingly.

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

- Run-level: max 4 concurrent changesets per run (configurable per project, default 4).
- Step-level: max N concurrent agent steps per run (configurable, default 12).
- Org-level: see multi-tenancy quotas.

## Why not just BullMQ alone

BullMQ is a queue; it doesn't model workflow state (the graph, the gates, the partial recovery). The orchestrator's job is the graph; BullMQ is its work-distribution mechanism. Postgres holds canonical state; BullMQ's queue is regenerated from Postgres on startup if needed.

## Migration path to Temporal

If V2 chooses Temporal:

- `DailyRun` becomes a Temporal Workflow.
- `WorkflowRun` and `Changeset` become child workflows.
- `AgentStep` becomes an activity.
- `gate_wait` becomes a `await Workflow.signal('HumanDecision')`.
- `rate_limit_wait` becomes `Workflow.sleep(retryAfter)`.

The current internal abstractions (OrchestratorClient API, AgentStep contract, Runner protocol) are designed to make this swap feasible without API churn for the rest of the system.
