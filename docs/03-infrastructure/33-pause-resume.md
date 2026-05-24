# Pause / Resume runs (operator kill switch)

Two scopes: per-project and org-wide. Either one being set blocks every run-dispatch path — scheduled cron, "Run now", and queued jobs that arrive mid-pause at the orchestrator. Org pause beats project pause: lifting the per-project pause while the org is still paused does nothing.

This is the safe answer to "my project keeps failing and burning tokens" or "we have a budget freeze for the next week." It does not require revoking the LLM provider API key.

## What pause blocks

| Action | Blocked by project pause | Blocked by org pause |
| --- | --- | --- |
| Scheduled cron tick (`worker-cron` enqueue) | yes | yes |
| `Run now` button / `POST /runs` API | yes | yes |
| Queued `run.due` job arriving at orchestrator | yes (defensive cancel) | yes (defensive cancel) |
| Webhook fan-out | no | no |
| End-of-day digest | no | no |
| Promote ritual | no | no |
| BYO runner-agent `/poll` returning jobs | no | yes (returns idle for the long-poll budget) |

The cancel on a queued job marks the `DailyRun` as `cancelled` with `metadata.cancelReason='paused'` and emits `RUN_CANCELLED` so the operator can see why nothing happened on the run-detail page.

### Pause + the BYO runner-agent (V2.af / #768)

For orgs whose `runner_profile.kind = 'agent'`, the API's `/v1/runner-agent/poll` endpoint checks `runsPausedAt` **before** popping the org's job queue. A paused org's agent stays connected and shows online (still bumping `lastSeenAt` via heartbeats it doesn't send during idle; it only sends them per job), but receives `{ kind: 'idle' }` for the full long-poll window even when jobs are queued. No new step state to manage — jobs remain in the queue and the **next poll after resume picks them up naturally**.

This matches the existing forward-looking pause semantics: in-flight steps on the agent's machine still report their outcomes (the outcome endpoint isn't pause-gated; the deployment must accept the reply so the step doesn't dangle). Only NEW dispatches stop.

The org-level concurrency cap (`organizations.org_concurrency_cap`) is already enforced upstream of the agent queue — the orchestrator's `dispatchAgentStep` defers the (N+1)-th step before LPUSH, so the agent queue never grows beyond the cap even during a load spike.

## What pause does **not** do

- **In-flight runs continue.** If a run is mid-agent-step when you hit Stop, it finishes (or fails or hits its rate-limit pause, whichever comes first). Pause is forward-looking. To kill the active run too, click `Cancel` on the run-detail page after pausing — the existing per-run cancel path handles the rest.
- **Webhooks, digests, and promote rituals are unaffected.** Pause is about run *execution*, not about comms blackout. If you need to suppress those, configure them separately.
- **No auto-resume.** Pause stays on until somebody explicitly clicks Resume. Time-based / budget-based auto-resume is a future enhancement (the `runsPausedAt` timestamp leaves room for it).

## Permissions

- `operator` role or higher can pause/resume at both scopes. Same role gate as `Run now` / `Cancel`.
- Every pause and resume writes an `audit_log_entries` row with `actorUserId`, `action` (`project.runs.paused` / `org.runs.paused` / matching `.resumed`), and the reason text. Visible on the org audit log page.
- Project pause also emits a `PROJECT_RUNS_PAUSED` / `PROJECT_RUNS_RESUMED` event to the project timeline. Org pause does not — N per-project emits for one operator action would be noise; the audit log is the source of truth there.

## Using it

### Project scope

- **UI**: Project page header → `Stop runs`. Optional 500-char reason. Resume is a one-click button when paused.
- **API**:
  ```
  POST /v1/orgs/:slug/projects/:projectSlug/pause   { "reason": "flaky agent" }
  POST /v1/orgs/:slug/projects/:projectSlug/resume
  ```
- **SQL** (break-glass):
  ```sql
  update projects set runs_paused_at = now(), runs_pause_reason = '...' where id = '<project-id>';
  -- resume:
  update projects set runs_paused_at = null, runs_pause_reason = null, runs_paused_by_user_id = null where id = '<project-id>';
  ```

### Org scope

- **UI**: Org dashboard header → `Stop all org runs`. Same reason field. Banner propagates to every project page, which hides the per-project Stop button while org pause is on.
- **API**:
  ```
  POST /v1/orgs/:slug/pause   { "reason": "budget freeze through Friday" }
  POST /v1/orgs/:slug/resume
  ```

## When to reach for it

- **Dogfooding a flaky lifecycle.** Mergecrew runs against your own repo and the agent loop keeps failing — pause the project, fix the lifecycle, resume.
- **Budget emergency.** Spend cap forecasting (`docs/03-infrastructure/13-spend-forecast.md`) flagged that you'll blow through the monthly cap by day 18; org-pause until you've adjusted the cap or the spend-cap-aware features land.
- **Vendor outage.** Anthropic / OpenAI is degraded enough that runs are timing out; org-pause until things recover, no need to revoke keys.
- **Compliance hold.** Security needs to freeze all autonomous code changes while they investigate something. Org-pause is the audit-friendly version of revoking provider keys.

## Pause vs. `Schedule.enabled`

They are different concepts and both still exist:

- `Schedule.enabled = false` → "manual-only mode." Cron stops firing. `Run now` still works. Use when you want to drive runs by hand for a while.
- `Project.runsPausedAt = <ts>` (this doc) → "kill switch." Cron, manual, and queued jobs all blocked. Use when you want runs to *stop*, not "slow down."

You can use both at once but you generally won't need to.

## Related

- [Monthly LLM spend cap](08-monthly-spend-cap.md) — pair with pause when responding to a budget emergency.
- [Operator runbook](05-operator-runbook.md) — diagnostic flows for *why* a project is failing before you reach for pause.
