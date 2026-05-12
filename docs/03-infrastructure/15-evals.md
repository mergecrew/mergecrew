# Evals

The eval harness is a regression detector, not a benchmark. It runs the agent against a small set of fixed synthetic projects every night and asks one question: **does the current agent + prompt + model produce a diff that still looks roughly like the one we expect?** When the answer drifts, you find out before a real customer does.

This page covers the surface area you'll actually touch: reading the dashboard, authoring a fixture, debugging a regression, A/B-comparing two model profiles, and the cases where adding an eval is the wrong call.

## What evals are (and aren't) for

**For:** catching the moment a model upgrade, a prompt edit, or a routing-tier change quietly breaks the agent. The whole point is the diff between yesterday's pass-rate and today's — not the absolute number.

**Not for:** scoring whether an agent's output is "best." Two agents can both produce a working diff that solves the fixture, and the eval will mark both as passing. Snapshot comparison checks file set + per-file line overlap; it does not grade aesthetics.

If you're tempted to write an eval to enforce a stylistic preference (variable name, code formatting), don't. That's a prompt change or a postprocessor, not an eval.

## Dashboard

Each org with `evalsEnabled = true` runs once per 23-hour window via worker-cron. Results land at `/orgs/:slug/evals`:

- **Header badge** on the Today page shows the latest run's pass-rate. Colors:
  - **green** ≥ 95%
  - **amber** ≥ 80%
  - **red** < 80%
- **Sparkline** above the recent-runs table shows the trailing 7-day pass-rate per run. Useful for spotting a slow drift the badge alone won't catch.
- **Recent runs** table shows source (`cli`, `cron`, `ab`), pass/fail/error counts, total USD spent, and total latency.
- **Run detail** page (`/orgs/:slug/evals/:runId`) expands failing cases inline with the full agent diff vs the expected diff. The first time you debug a regression, this is the page you spend an hour on.

The cron is **opt-in per org**. Toggle `Nightly evals` in Settings to start. Toggling off bumps `evalsEnabled` to false on the next tick.

## Authoring a fixture

Each fixture is a directory under `packages/eval-fixtures/fixtures/<id>/` containing:

- `manifest.yaml` — fixture metadata (see below)
- `expected.diff` — the unified-diff the agent is expected to produce
- the source tree the agent will run against (`src/`, `package.json`, etc.)

### `manifest.yaml`

```yaml
id: node-express-small
description: Express server crashes on /healthz — the handler is missing a return statement.
intent: |
  Fix the /healthz handler so it responds 200 with body {ok: true}.
  Don't touch other routes.
language: typescript
runtime: node
expectedFiles:
  - src/routes/health.ts
tolerances:
  ignoreLocalRenames: true
  ignoreWhitespaceOnly: true
```

| Field | What it does |
|---|---|
| `id` | Unique slug; must match the directory name. The harness uses it as the EvalCase row's `fixtureId`. |
| `description` | One-line summary shown in the run-detail UI. |
| `intent` | The prompt the agent receives. Keep it bounded — a vague intent produces unstable diffs that fail half the time for the wrong reason. |
| `language` / `runtime` | Surface metadata for filtering; not used for scoring. |
| `expectedFiles` | Files that **must** appear in the agent's diff. The fixture fails if any are missing, regardless of line overlap. |
| `tolerances.ignoreLocalRenames` | Normalize identifiers to `IDENT` before comparing — passes when the agent renames a local variable. |
| `tolerances.ignoreWhitespaceOnly` | Collapse whitespace before comparing — passes when the agent reformats. |

### `expected.diff`

Standard unified diff, one or more files. The harness compares the agent's diff against this one using:

1. **File set check** — every path in the agent's diff must also be in `expected.diff` (or vice versa, depending on direction), and every `expectedFiles` entry must be present.
2. **Per-file line overlap** — at least 50% of the expected diff's `+` and `-` lines must also appear in the agent's diff for that same file, after applying tolerances.

The 50% threshold is intentionally loose. An eval enforcing exact diff match would fail on every legitimate prompt iteration. We're checking that the agent solved roughly the same problem in roughly the same place, not that it produced byte-identical output.

### Sanity-check before committing

```sh
pnpm --filter @mergecrew/eval-fixtures test
pnpm --filter @mergecrew/eval-runner -- run -- --org <your-org> --fixtures <new-fixture-id>
```

The first command exercises the fixture loader. The second runs the new fixture end-to-end against your org's configured LLM profile so you can see the live agent diff before the cron starts billing for it.

## Debugging a regression

When the digest fires an `eval_regression` anomaly or the badge turns amber:

1. **Open the failing run** (`/orgs/:slug/evals/:runId`). The cases table lists every fixture and its pass/fail/error state.
2. **Expand a failing case** to see the agent's diff and the expected diff side-by-side.
3. **Look for these common false positives** before you assume the agent broke:
   - **Renamed locals.** Agent renamed a parameter; tolerance should cover it. If it doesn't, set `tolerances.ignoreLocalRenames: true` in the fixture manifest.
   - **Reformatting.** Agent's formatter inserted/stripped whitespace. Set `tolerances.ignoreWhitespaceOnly: true`.
   - **Timestamp / UUID drift** in generated files. Fixture should exclude those files from `expectedFiles` and the diff should not include them.
   - **Different but equivalent file path.** Agent moved logic to a sibling file. If the new location is acceptable, update `expected.diff`; if not, that's a real regression in the prompt.
4. **If the diff is genuinely wrong**, the regression is real. Common root causes, roughly in order of frequency:
   - A model upgrade (provider quietly migrated `claude-X.Y` to `claude-X.Y+1`)
   - A prompt edit in the runner agent
   - A routing-tier change that swapped a cheaper model in for a step
   - A new tool definition that the model isn't using correctly yet
5. **Roll back the change** that landed between the last green run and the first failing one. The recent-runs table includes start timestamps; cross-reference with git log for the runner / prompt files.

## A/B compare

The A/B path (`/orgs/:slug/evals/compare/:abRunId`) runs the same fixture set against two LLM profiles and reports both pass-rates side-by-side. Use it when:

- You're considering switching from one provider to another for a routing tier.
- You want to validate a prompt change doesn't regress before merging it.
- You want to see whether a cheaper model can replace a pricier one for a specific step.

### Cost

Each A/B run costs roughly **2× a normal nightly run** (since each fixture executes twice). The compare report includes total USD per profile, so the cost delta between profile A and profile B is itself a signal: if profile B is 30% cheaper *and* matches pass-rate, that's actionable.

### Kicking it off

```sh
pnpm --filter @mergecrew/eval-runner -- run -- --org <org-slug> --ab <profile-a-id>,<profile-b-id>
```

The CLI creates an `EvalAbRun` row up front (with placeholder run ids), runs each profile, then back-patches the child run ids. If one profile crashes mid-run, the partial wrapper still exists with the surviving run id — you can see which side failed.

## When NOT to add an eval

- **You're trying to lock in agent output verbatim.** Diff snapshots are intentionally permissive; if you need an exact match, you want a unit test, not an eval.
- **The fixture relies on randomized output.** UUIDs, timestamps, hash-based identifiers. The eval will flap. Filter them out of the diff or pick a different scenario.
- **The behavior you're checking is already covered by a CI test in the runner / domain package.** Evals are for end-to-end agent behavior, not for things a unit test can prove faster and more cheaply.
- **You're racing a model release.** A new fixture should be stable across at least two consecutive nightly runs before you trust its baseline. Adding a fixture the night before a model upgrade and then panicking when it fails on day one is self-inflicted.

## Tuning the regression threshold

The digest anomaly fires when today's pass-rate drops more than 10% below the trailing-7-day median, gated on at least 5 historical runs. Both constants live in `apps/orchestrator/src/digest-anomalies.ts`:

```ts
const EVAL_REGRESSION_DROP_PCT = 10;
const EVAL_REGRESSION_MIN_HISTORY = 5;
```

If you're seeing false-positive regressions because your fixture set is small and noisy, raise `EVAL_REGRESSION_DROP_PCT` rather than removing fixtures. Coarse signal beats no signal.

## Related

- [Anomaly digest](14-anomaly-digest.md) — where `eval_regression` lands
- [Operator runbook](05-operator-runbook.md) — what to do once a regression is confirmed
- [Telemetry](07-telemetry.md) — EvalRun rows feed the same observability path as run/changeset events
