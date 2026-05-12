# Spend forecast

A hard monthly cap is only useful if operators know they're heading for it *before* it fires. The spend forecast computes a straight-line projection from the trailing 7-day average and surfaces a banner well in advance of the cap kicking in.

## How the projection works

```
trailing7DayAvgUsd  = SUM(LlmInvocation.usdEstimate for the prior 7 full UTC days) / 7
projectedMonthEndUsd = monthToDateUsd + trailing7DayAvgUsd × daysRemainingInMonth
```

A few deliberate choices:

- **Trailing 7 days, not 30.** New projects and recently-tuned lifecycles produce cost trajectories that shift over a couple of weeks. A 7-day window catches recent changes; 30 days would smear over old behavior.
- **Excludes today.** Today is partial — including it would underestimate. Tomorrow becomes a full data point that pushes the window forward.
- **Straight line, not ML.** The point is honest signal, not clever prediction. If you doubled traffic yesterday, the projection lags reality by ~7 days. That's a feature: the trend has to be sustained before it changes the forecast.

## What you'll see

Three surfaces report the forecast:

### Org settings → Monthly LLM spend cap card

- Trailing 7-day avg / day
- Projected month-end
- If `projectedMonthEndUsd > cap`: an amber callout `"On track to exceed the cap by ~$X. At the current 7-day pace you'll hit the cap around day N of the month."`

### Org dashboard (`/orgs/:slug`)

When projection exceeds the cap, a passive banner shows above the projects list with an **Adjust cap** button linking to settings.

The banner is informational, not blocking. It does *not* prevent runs from continuing — that's the cap's job, not the forecast's.

### API

`GET /v1/orgs/:slug/spend-cap` returns:

```json
{
  "monthlySpendCapUsd": 100,
  "monthToDateUsd": 47.20,
  "trailing7DayAvgUsd": 4.10,
  "projectedMonthEndUsd": 117.50,
  "daysToCapExceedance": 25,
  "projectionExceedsCap": true,
  "remainingUsd": 52.80,
  "exceeded": false
}
```

`daysToCapExceedance` is the projected day-of-month the cap would be hit. Null when there's no cap or no overrun is projected.

## What to do when the banner fires

You're looking at the projection 1–3 weeks before the actual cap would hit. Options, roughly in order of preference:

1. **Tune per-step budgets.** Most overruns come from one or two agents producing oversized turns. Edit `agents.<ref>.budget.usd` in `mergecrew.yaml` to ratchet down the worst offender.
2. **Switch model.** If a sensitive workflow doesn't need Opus, shift its routing to Sonnet or a local model. The LLM profile editor under org settings makes this a one-click change.
3. **Pause low-value projects.** If one project is eating most of the budget but is exploratory, archive it for the month and revisit in the next cycle.
4. **Raise the cap.** Honest answer when usage is growing because the product is working. Update under Settings → Monthly LLM spend cap.

What *not* to do: leave the banner up indefinitely. Either the projection is real (act on it) or your usage is mid-pivot and the projection is stale (it'll self-correct within ~7 days).

## What the forecast does not do

- It doesn't account for the day-of-week pattern. If your runs are weekday-heavy and the next 5 days happen to be a weekend, the projection overshoots. Don't sweat ±10%.
- It doesn't account for one-time spikes. A bad-day cost-bomb (one agent loops uncontrolled for a few hours) gets averaged into the 7-day window for a week, then drops out.
- It doesn't project per-project. Project-level forecasts can come once we have per-project caps (#283 only covers org-level).

## Related

- [Monthly LLM spend cap](08-monthly-spend-cap.md) — the hard ceiling the forecast is warning about.
- [Operator runbook → `budget_exhausted`](05-operator-runbook.md#budget-exhausted) — what happens when the cap actually fires.
