# Operator runbook

What to do when something looks wrong in a self-hosted Mergecrew. Each entry is a symptom-to-recovery row plus the source file you can read in 30 seconds to verify the diagnosis. Health and queue metrics referenced below are exposed at `/healthz` and `/metrics` on the API and orchestrator — see [04-observability.md](04-observability.md).

## Failure modes

### Step stuck running for >10 min
<a id="step-stuck-running"></a>

**Symptom.** The run-detail page shows a step in `running` for longer than the agent's `maxStepsPerRun × maxToolCallsPerStep` budget could plausibly account for. `mergecrew_orchestrator_tick_age_seconds` may also be normal — the *orchestrator* is healthy; it's the *runner* that's stopped writing heartbeats.

**Likely cause.** The runner that picked up this step is dead (OOM-killed, drained mid-task, partitioned from the DB) so `agent_steps.heartbeat_at` is stale. The heartbeat sweeper in the orchestrator detects this and re-dispatches with per-attempt exponential backoff — by default 90s for attempt 2, 180s for attempt 3, capped at one hour.

**Recovery.**
1. Check `agent_steps.heartbeat_at` for the stuck step — anything older than `ORCHESTRATOR_HEARTBEAT_STALE_AFTER_MS` (default 90s) is past the threshold.
2. Look in orchestrator logs for `sweeper: re-dispatched stale step` / `sweeper: still in per-attempt backoff window, skipping re-dispatch` to see where the sweeper is in its backoff schedule.
3. If the step has already been re-dispatched 3 times (the `maxAttempts` default), the orchestrator marks it `failed` with reason `runner_dead`. Operator intervention is then to: cancel the run from the UI, find why the runner died (often `RUNNER_MEM_LIMIT` set too tight, see `docker-compose.prod.yml`), bump the limit, and let the next scheduled run retry.

**Source.** `apps/orchestrator/src/heartbeat-sweeper.ts`. The thresholds are `ORCHESTRATOR_HEARTBEAT_SWEEPER_INTERVAL_MS`, `ORCHESTRATOR_HEARTBEAT_STALE_AFTER_MS`, `ORCHESTRATOR_HEARTBEAT_MAX_ATTEMPTS`.

### Run terminated as `budget_exhausted`
<a id="budget-exhausted"></a>

**Symptom.** Run row reaches a terminal state with status `budget_exhausted` and the eventlog shows `AGENT_STEP_FAILED reason=org_daily_budget_exhausted`. The cost dashboard shows today's org spend at or above the configured cap.

**Likely cause.** Either the org-wide daily budget (`organizations.dailyBudgetUsd`) or the per-step budget on the agent definition (`agents.<ref>.budget`) was exhausted. Mergecrew gates both at *step* entry so a single LLM call can't push you arbitrarily over.

**Recovery.**
1. Confirm which gate fired: `org_daily_budget_exhausted` in the eventlog means the org cap; otherwise the step's own `BudgetTracker` ran out.
2. To bump the org cap: `update organizations set daily_budget_usd = <new value> where id = '<org-id>'`, or via the org settings page → Budget.
3. To bump the per-step cap: edit `agents.<ref>.budget.{tokens,usd}` in `mergecrew.yaml` and save (creates a new lifecycle version).
4. To leave the cap untouched and just let *today's* run through: the cap resets at UTC midnight per `checkDailyBudget`. There's no override.

**Source.** Org cap: `apps/runner/src/step.ts` (look for `checkDailyBudget`). Per-step cap: `packages/agent-runtime/src/budget.ts`.

### Deploy adapter timeout
<a id="deploy-timeout"></a>

**Symptom.** Smoke test or run-time deploy returns `{deployStatus: 'timeout'}`. The adapter actually completed the deploy correctly — Mergecrew just stopped polling.

**Likely cause.** The default polling envelope is 5 minutes (`SMOKE_TEST_TIMEOUT_MS`, `apps/api/src/modules/project/smoke-test.service.ts:143`). Larger Next.js / Docker / ECS deploys routinely exceed that.

**Recovery.**
1. For the onboarding smoke: set `SMOKE_TEST_TIMEOUT_MS` on the API container.
2. For runtime deploys: each adapter has its own polling backoff (see `awaitCompletion` in `packages/adapters-deploy/src/<adapter>.ts`). The orchestrator's per-adapter envelope is implicit — bump the surrounding step's `timeoutMs` on its agent definition if you need more.
3. **Don't** raise the timeout to mask a stuck deploy. Check `deploy.fetchLogs(handle)` first — a 30-minute "deploy" is usually a crash-looping container, not a slow build.

**Source.** `apps/api/src/modules/project/smoke-test.service.ts`. Per-adapter `awaitCompletion`: `packages/adapters-deploy/src/{github-actions,vercel,netlify,render,railway,fly,aws-direct}.ts`.

### Agent blocked on a sensitive path (`gated_reject`)
<a id="gated-reject"></a>

**Symptom.** Step ends with `outcome.kind: 'gated_reject'` and a reason field of `sensitive_path` (or similar). The agent never wrote any code; the run-detail page shows a policy decision against a tool call.

**Likely cause.** The agent tried to edit a file matched by either the agent's own `do_not_touch` patterns or the project-wide `human_gates.sensitive_path_patterns` list. Defaults block `apps/*/src/auth/**`, `apps/*/src/billing/**`, `**/migrations/**`, `**/.env*`.

**Recovery.** Two paths depending on intent:

1. **The change really is sensitive and a human should review it.** Open a tracker issue describing what the agent wanted to do, do the change manually, and merge. Mergecrew's policy is "automate the easy 80%, escalate the rest."
2. **The pattern is too aggressive for this project.** Edit `lifecycle.human_gates.sensitive_path_patterns` in `mergecrew.yaml` (or the per-agent `do_not_touch` list) and save. The next run picks up the relaxed policy.

**Source.** `apps/runner/src/step.ts` (look for `projectSensitivePatterns`). Policy engine: `packages/agent-runtime/src/policy.ts`.

### GitHub App can't clone the repo
<a id="vcs-clone-failed"></a>

**Symptom.** Smoke test or run fails on the very first VCS call (`cloneIntoWorkspace`) with one of: `404 Not Found`, `401 Bad credentials`, `403 Resource not accessible by integration`, or a git-side `Repository not found`.

**Likely cause.** Usually one of:
- The Mergecrew GitHub App installation was suspended or uninstalled from the repo's organization.
- The installation lost access to the specific repo (someone removed it from the App's repo selection).
- The repo was renamed or made private without re-granting App access.
- The repo exceeded GitHub's installation token size limit (~2 GB clone).

**Recovery.**
1. Confirm the App is still installed at `https://github.com/organizations/<org>/settings/installations/<installation-id>`.
2. Check the App has Read/Write on the specific repo, not just "All public repositories".
3. If the repo was renamed, update `connected_repos.repo_full_name` to match (or reconnect via the project settings page so the row updates correctly).
4. For repos >2 GB, the underlying limitation is GitHub's — split the repo, use a sparse checkout (Mergecrew uses `--depth 50 --filter=blob:none` already, see `packages/adapters-vcs/src/github.ts:85`), or migrate to Git LFS.

**Source.** `packages/adapters-vcs/src/github.ts` (`cloneIntoWorkspace`). Installation row: `connected_repos` table.

### Prisma migrate fails on startup
<a id="prisma-migrate-failed"></a>

**Symptom.** API or migrate container exits non-zero with `P1010` (User denied access), `P3009` (failed migration in history), or `P1012` (schema validation). The compose stack never gets past the `migrate` service.

**Likely cause.**
- `P1010`: the role in `DATABASE_MIGRATE_URL` doesn't have BYPASSRLS. Migrations apply schema-level changes that RLS would refuse for non-bypass roles.
- `P3009`: a previous migration was applied partially. Prisma refuses to continue until the failed entry is resolved.
- `P1012`: schema.prisma was edited without re-running `prisma generate` — the binary targets in the schema don't match the engines in node_modules.

**Recovery.**
1. **P1010:** verify `mergecrew_migrator` was created with BYPASSRLS by `infra/sql/init/00-roles.sql`. Re-run that SQL against the DB if the role is missing:
   ```sh
   psql "$DATABASE_URL" -f infra/sql/init/00-roles.sql
   ```
2. **P3009:** inspect `_prisma_migrations` — find the row with `finished_at IS NULL`, fix the underlying problem (often a schema constraint violation), then `prisma migrate resolve --applied <migration-name>` from a container with the migrator URL.
3. **P1012:** rebuild with `prisma generate` baked in (the production Dockerfiles already do this in the build stage).

**Source.** `packages/db/prisma/schema.prisma` (binary targets). Role bootstrap: `infra/sql/init/00-roles.sql`. Migration history: `packages/db/prisma/migrations/`.

### BullMQ queue depth keeps growing
<a id="queue-depth-growing"></a>

**Symptom.** `mergecrew_queue_depth{queue="runner.step", state="waiting"}` (or any queue) climbs and doesn't fall back to zero. Run-detail pages stall on `queued`.

**Likely cause.** One of:
- The orchestrator stopped consuming. Check `mergecrew_orchestrator_tick_age_seconds` — anything above the configured staleness threshold means the sweeper is wedged.
- Redis ran out of memory and is evicting keys (BullMQ jobs get silently dropped). Check `redis-cli info memory` and the eviction policy.
- The runner pool is too small for the offered load. Each runner consumes one `runner.step` job at a time; the orchestrator dispatches concurrently up to the org concurrency cap.
- A specific job keeps poisoning the worker (BullMQ retries it forever by default). Check the queue's `failed` state and look at the failed jobs' `failedReason`.

**Recovery.**
1. **Wedged orchestrator:** restart it. The heartbeat sweeper resumes from where it left off (the DB rows are the source of truth, not the queue). Look at the orchestrator logs in the minute before the restart to find the trigger.
2. **Redis OOM:** raise `maxmemory`, switch to `allkeys-lfu` eviction *only* if you're OK losing in-flight jobs (you usually aren't — see [03-credit-and-rate-handling.md](03-credit-and-rate-handling.md) for the cost-tracking risk).
3. **Runner pool too small:** scale up the runner replica count. The orchestrator's `ORG_CONCURRENCY_CAP` is the upper bound — set it as wide as the runner pool can handle.
4. **Poison job:** purge it from BullMQ's `failed` state. Filter to a specific job with `redis-cli LRANGE bull:runner.step:failed 0 -1` and use BullMQ's job-removal pattern; in extreme cases, `redis-cli DEL bull:runner.step:failed` drops them all.

**Source.** Orchestrator queue wiring: `apps/orchestrator/src/main.ts`. Per-job retry behavior: each `Worker(...)` instance there. Concurrency cap: `apps/orchestrator/src/orchestrator.ts` (look for `OrgCapacityGate`).

## Where the signals live

Quick reference for "I don't know which symptom this is yet":

| Signal | Where |
| --- | --- |
| Per-service health | `GET /healthz` on API (`:4000`) and orchestrator (`:9090`) |
| Per-service metrics | `GET /metrics` (Prometheus) on both |
| Run-level state machine | `daily_runs.status`, `workflow_runs.status`, `agent_steps.status` in Postgres |
| Per-event timeline | `event_log` table; the timeline UI replays from there |
| Cost spend per org | `cost` page in the web UI; raw data in `llm_invocations` |
| Configuration drift | `lifecycles` table; each YAML save creates a new versioned row |
| Adapter calls / failures | Look at the `tool_calls` table for a step; `output` and `isError` are the contract |

## What this runbook deliberately doesn't cover

- **Auto-remediation.** That's [V3 #38](https://github.com/mergecrew/mergecrew/issues/38) (deferred — needs design). The runbook stays as docs until then.
- **Capacity planning.** Sizing the runner pool and Postgres is a separate concern in [01-overview.md](01-overview.md).
- **Per-cloud deploy guides.** The Dockerfiles and `docker-compose.prod.yml` are the contract; how you operate them on AWS / GCP / Hetzner is operator-specific.
