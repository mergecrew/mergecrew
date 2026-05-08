# Success metrics

The metrics Mergecrew optimizes for, organized by who they matter to.

## North star

**Promoted-changesets-per-project-per-week.** Concrete, user-meaningful work that landed in production with the user's blessing. This metric is robust to gaming (you can't fake a production deploy that the user didn't approve) and ties directly to value delivered.

Healthy V1 target: **≥ 5 promoted changesets per active project per week.**

## Activation funnel

Measured for every signed-up org:

| Step | Definition | V1 target |
|---|---|---|
| Sign up | Org created | 100% baseline |
| First repo connected | A GitHub repo is linked and Inception ran | ≥ 70% within 24h |
| First daily run completed | A run reached the "digest ready" state | ≥ 60% within 48h |
| First changeset reviewed | User opened a changeset detail view | ≥ 55% within 48h |
| First promotion | User pressed Promote at least once | ≥ 40% within 7d |
| Activated | ≥ 3 promotions across ≥ 3 distinct days | ≥ 25% within 14d |

## Quality

| Metric | Definition | V1 target |
|---|---|---|
| Promote rate | promoted / (promoted + rolled-back + deferred>7d) | ≥ 50% |
| Auto-fail rate | runs that errored before producing any changeset | ≤ 5% |
| Mid-run pause-and-resume success | runs that hit a 429 and recovered without user action | ≥ 99% |
| Rollback-from-prod rate | of promoted changesets, % rolled back from prod | ≤ 3% |
| False-flag rate on sensitive areas | of human-gated escalations, % the user said "this didn't need a gate" | trend down month over month |
| Changeset-to-promote latency | median time from "ready for review" to user decision | ≤ 18h |

## Reliability

| Metric | Definition | V1 target |
|---|---|---|
| Run completion rate | runs that finished without process error | ≥ 95% |
| Orchestrator availability | uptime of run scheduler | ≥ 99.9% |
| Real-time stream uptime | SSE channel availability during active runs | ≥ 99.5% |
| Provider failover success | when primary provider 429s, fallback handled the request | ≥ 95% |
| Time-to-resume after a 429 | wall clock from limit hit to next agent step | ≤ 1.2× the `Retry-After` value |

## Cost

| Metric | Definition | V1 target |
|---|---|---|
| Median tokens per changeset | input + output tokens consumed end-to-end for one changeset | tracked, no target in V1 |
| Cost per promoted changeset | total token cost / number of promoted changesets that day | trend down across releases |
| Wasted-spend ratio | tokens spent on rolled-back changesets / total tokens | ≤ 25% |

## Engagement

| Metric | Definition | V1 target |
|---|---|---|
| WAU/MAU on the digest | distinct users opening the digest | ≥ 0.6 |
| Mobile-digest share | % of digest opens on mobile | tracked (informs design priorities) |
| Approval-via-Slack share | % of approvals decided in Slack vs the web UI | tracked |
| Time-to-decision in digest | median seconds from open to first action | ≤ 60s |

## Anti-metrics (we explicitly do NOT optimize for these)

- **Lines of code generated.** Volume is not value.
- **PRs opened.** Same reason.
- **Tokens consumed.** We're not paid by token; tokens are a cost, not a goal.
- **Time on platform.** Mergecrew is meant to take work *off* the user's plate, not pull them into the UI.

## Observability instrumentation required for V1

- Every metric above must be derivable from events emitted into a queryable store (PostgreSQL + a time-series view, or an analytics warehouse if one is already wired in).
- Every metric must be sliceable by: `org_id`, `project_id`, `lifecycle_node`, `agent_kind`, `provider`, `model_id`.
- The digest's "review latency" measurement must respect user timezone and working hours.

## Reporting cadence

- Internal: weekly review of the metrics above.
- Per tenant (V1.x): a monthly email summarizing their org's promoted/rolled-back counts, rate-limit interruptions, and total token spend.
