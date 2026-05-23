# ADR-0005: Per-run driver dispatch via profile-specific BullMQ queues

**Status:** Accepted — 2026-05-23.

## Context

Once `runner_profile.kind` is per-org (ADR-0002), the orchestrator must decide where to send each step. Two shapes were considered:

1. **One queue (`runner.step`), runtime branching in the consumer.** Today's supervisor would inspect the job, look at the org's profile, and either run it locally or… do something else. For an agent-profile job, the supervisor would have to either proxy the job back to the API (silly — the API just enqueued it) or hold the job until the agent appears (loads the supervisor with state it shouldn't carry).
2. **One queue per profile kind, with one queue _per org_ for the `agent` kind.** Orchestrator routes at enqueue time. Each consumer is single-purpose: the supervisor consumes only the `instance` queue; the API's long-poll endpoint `BRPOP`s the org-specific agent queues; a small dispatcher worker consumes the cross-org `fargate-byo` queue and assumes the role per-job.

Option 2 keeps each consumer's concerns clean and matches BullMQ's strengths.

## Decision

Queues:

- `runner.step.instance` — consumed by the existing supervisor (`apps/runner`). Trusted orgs only.
- `runner.step.agent.<orgId>` — one queue per org with `kind=agent`. Consumed by the API's `POST /runner-agent/poll` long-poll endpoint via `BRPOP`. The agent never sees other orgs' jobs.
- `runner.step.fargate-byo` — single cross-org queue. A new dispatcher worker consumes it, assumes the requesting org's IAM role (per-job), and runs an ECS task in their AWS account.
- `runner.step.github-actions` — single cross-org queue. Dispatcher calls `workflow_dispatch`. (Deferred to v1.1; see follow-up issue #772.)

Orchestrator (`apps/orchestrator/src/orchestrator.ts:706`) gets a `resolveRunnerQueue(orgProfile)` helper that picks the queue at `dispatchAgentStep` time. For `kind=none`, the orchestrator does not enqueue — it marks the step `failed` with reason `runner_not_configured` and emits `AGENT_STEP_FAILED` (see ADR-0008).

Backward compatibility: the legacy `runner.step` queue is renamed to `runner.step.instance`. A one-release bridge worker drains any leftover `runner.step` jobs (from a deploy that races with the rename) and re-enqueues them to `runner.step.instance`. Removed in the release after #763 ships.

## Consequences

- Queue cardinality grows with the number of `agent`-kind orgs (one queue each). Acceptable: each queue is cheap in BullMQ/Redis (a list + a hash), and only orgs that pick `agent` get one.
- Each consumer is focused — no `switch` on profile kind inside the supervisor.
- The cross-org `fargate-byo` queue could become a bottleneck under heavy load (one worker pool serving every BYO Fargate org). We can shard later if needed; not a v1 concern.
- Adding a new profile kind in the future means adding a queue + a dispatcher, not branching every existing consumer.

## Alternatives considered

- **Single queue + runtime branch.** Rejected for the reasons above — couples the supervisor to credentials and code paths it shouldn't carry, and makes the consumer the dispatch decision-maker instead of the orchestrator.
- **Per-org queue for every profile kind.** Rejected: only `agent` actually needs per-org isolation (because the agent itself is the consumer). For `fargate-byo` and `github-actions`, the consumer is a deployment-owned worker that handles many orgs; per-org queues there would inflate cardinality with no benefit.
- **One queue per agent process (not per org).** Considered for the multi-agent case but rejected: an org with two agents running in parallel benefits from a single shared queue (load is balanced by `BRPOP` fairness), and one-queue-per-agent would complicate enrollment.
