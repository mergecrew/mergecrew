# Anomaly highlights in the daily digest

Operators don't watch the dashboards every day. The end-of-working-hours digest is where "something weird happened" gets caught. The anomaly section sits above the regular changeset list and surfaces five categories of signal, each tied to one of the V2.aa guardrails.

## What gets flagged

| Kind | Triggers when | Likely cause | Where to look |
|---|---|---|---|
| `cost_spike` | today's project LLM spend > 2× trailing-7-day daily avg | Runaway loop, bad prompt, model fallback to a pricier provider | `/orgs/:slug/costs` |
| `blocked_changeset` | a changeset hit the blast-radius gate (#285) in the digest window | Agent tried to touch too many files / hit a deny-glob | changeset detail page |
| `risk_gate_hit` | a changeset crossed `autoMergeThreshold` (#286) | Large or sensitive diff that should have human eyes | inbox + changeset detail |
| `rollback` | an admin clicked one-click rollback (#287) | A merged change had to be undone | changeset detail page |
| `file_spike` | a single changeset touched > 2× the trailing-30-day median file count | Agent generated a sprawling change | changeset detail page |

Empty section is never rendered — if nothing fired, the digest doesn't pad. That's deliberate: the highlights have to mean something every time they appear.

## What it doesn't do

- **No real-time alerts.** Detection runs once per digest tick. If you need pager-style alerts, add a webhook subscription to the underlying timeline events (`CHANGESET_FLAGGED`, `GATE_REACHED`, `CHANGESET_ROLLED_BACK`).
- **No ML.** Threshold-based, tunable in code today (`COST_SPIKE_MULTIPLIER` and `FILE_SPIKE_MULTIPLIER` constants in `apps/orchestrator/src/digest-anomalies.ts`). Lift them to project settings once the defaults prove insufficient.
- **No cross-project rollup.** Each project's digest covers only its own state. Org-wide cost spike detection lives with the spend-cap forecast (#283), not here.

## How the detectors work

The detectors run in `collectDigestAnomalies`. Each is independent and best-effort — a query failure for one detector is logged and skipped so a corrupt row can't suppress the rest of the digest.

The window is one UTC day ending at the digest's `eod` timestamp. Trailing windows for the cost-spike (7 days) and file-spike (30 days) reference the prior period *excluding* the window itself, so today's data can't bias its own baseline.

The file-spike detector needs at least 5 historical changesets with `riskScoreBreakdown` populated before it fires. That avoids a 1-of-1 false positive on a brand-new project where the very first changeset is "spiking" against an empty history.

## Tuning

The two multipliers are currently constants. Defaults:

- `COST_SPIKE_MULTIPLIER = 2` — today must be > 2× the trailing avg
- `FILE_SPIKE_MULTIPLIER = 2` — single changeset must be > 2× the trailing median

Move them per-project when there's actual demand. A common reason: monorepo projects regularly touch 50+ files, so the file-spike multiplier needs to be loosened to avoid noise.

## Reading a noisy digest

If you're seeing the same `risk_gate_hit` for the same changeset every day, the changeset is sitting in the inbox unresolved — approve or reject it.

If `cost_spike` fires repeatedly, look at the trailing-7-day forecast (#283). The forecast is the leading indicator; the daily spike is the lagging one. Tune the per-step `agents.<ref>.budget.usd` or downgrade a routing tier before you cross the monthly cap.

If `blocked_changeset` fires repeatedly with the same glob hit, the deny-list is over-aggressive for this project. Loosen it under Settings → Guardrails → Blast-radius limits.

## Related

- [Blast-radius limits](10-blast-radius.md) — source of `blocked_changeset`
- [Risk-score gate](11-risk-score-gate.md) — source of `risk_gate_hit`
- [One-click rollback](12-rollback.md) — source of `rollback`
- [Spend forecast](13-spend-forecast.md) — leading indicator the daily `cost_spike` is a lagging version of
