# Monthly LLM spend cap

The monthly spend cap is the hard ceiling on what Mergecrew is allowed to bill against your LLM providers in a calendar month. It's the first guardrail you should configure on a real organization — the daily budget (`organizations.daily_budget_usd`) prevents one bad day, but only the monthly cap prevents the case of "daily limit set too generously × every day for three weeks."

## How it works

- One number per org: `organizations.monthly_spend_cap_usd`. `NULL` (the default) means unlimited.
- Enforcement runs **once at agent-step entry** in the runner — see `apps/runner/src/step.ts` (`checkMonthlyCap`). If month-to-date spend ≥ cap, the step is refused before any LLM call. The eventlog records `reason=org_monthly_cap_exceeded`.
- The calendar month is UTC, anchored to the 1st of the month at 00:00 UTC. This matches how Anthropic, OpenAI, and Bedrock invoice — your Mergecrew month-to-date should track your provider invoice within a few cents.
- The cap is independent of the daily budget. Both fire; whichever you hit first stops the step.

## Where you see the numbers

- **Settings page** (`/orgs/:slug/settings` → "Monthly LLM spend cap" card) — current cap, month-to-date, remaining, and a usage bar that turns amber at 80% and red at 100%.
- **Eventlog** — entries with `reason=org_monthly_cap_exceeded` whenever a step is refused.

## Recommended starting values

A safe first cap for a single small project running Mergecrew with the default daily lifecycle: **\$20–\$50/month** when using Anthropic Claude Sonnet, **\$5–\$15/month** when using a mostly-local Ollama profile with a hosted model only for plan/review steps.

These are conservative — Mergecrew's per-step token budgets already throttle individual runs. The cap is the seatbelt, not the throttle.

## What happens when the cap fires

- Every subsequent agent step in the affected org returns immediately with `outcome.kind = 'budget_exhausted'`. No model is called.
- Runs that depend on those steps end with the same status. Scheduled runs the next day still attempt — they just hit the same refusal until either the calendar month rolls over or you raise the cap.
- VCS and deploy adapters are **never** invoked for a step that was refused, so a cap-hit can't leave behind a half-built changeset.

## Raising or removing the cap

- Via UI: Settings → "Monthly LLM spend cap" → enter a new value or leave the input empty to remove the cap.
- Via SQL: `update organizations set monthly_spend_cap_usd = <new value or NULL> where id = '<org-id>';`
- Changes take effect on the next step entry — no restart, no cache to bust.

## What it does **not** do

- It does not retroactively halt a step that was already mid-flight when the cap was hit. The check runs at step entry, not mid-iteration. That's a deliberate trade — see [01-overview.md](01-overview.md#why-step-entry-budgets) for the rationale.
- It does not partition spend by project. The cap is org-wide. Per-project caps are tracked separately under the V2.aa Guardrails milestone (#283).
- It does not auto-disable scheduling. Failed runs continue to attempt; the operator decides whether to disable schedules in response.

## Related

- [Operator runbook → `budget_exhausted`](05-operator-runbook.md#budget-exhausted) — diagnostic flow when a run lands in this state.
- [Credit and rate handling](03-credit-and-rate-handling.md) — how LLM cost is estimated per call.
