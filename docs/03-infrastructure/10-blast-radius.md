# Blast-radius limits

A single agent run that rewrites 200 files or touches the migrations directory is almost never desirable. The blast-radius gate is the hard ceiling: it sits between the agent loop and `git push`, computes the diff against the project's default branch, and refuses to push any changeset that breaches the limits.

## What it enforces

Three knobs, all per-project:

| Setting | Default | Meaning |
|---|---|---|
| `maxFilesChanged` | 25 | Distinct paths the changeset is allowed to touch. |
| `maxLinesChanged` | 1000 | Sum of additions + deletions across the diff. Binary files count as 0 lines but still consume a file slot. |
| `deniedPaths` | `["**/migration*", "**/secrets*", "**/.env*", "**/*.pem", "**/*.key"]` | Picomatch globs; any changed path that matches blocks the changeset. |

The check runs in the runner, *after* the agent has committed locally but *before* the push step in `openPendingChangesetPrs`. The diff is computed with `git diff --numstat origin/<defaultBranch>...<branch>` against the local workspace — no remote round-trip needed.

## What happens on a hit

The changeset stays in the database with:

- `status = 'blocked'`
- `blockedReason` = structured JSON describing each cap that fired, including:
  - `filesChanged`, `linesChanged` — what we measured
  - `maxFilesChanged`, `maxLinesChanged` — the configured caps
  - `filesOverLimit`, `linesOverLimit` — booleans flagging which caps fired
  - `deniedHits` — list of `{ path, glob }` pairs, one per file that matched a deny pattern (capped at one glob per file)

The runner emits a `CHANGESET_FLAGGED` timeline event with `reason: 'blast_radius'`. The changeset detail page renders the breakdown verbatim — operators see exactly which limit caught the change and which files (if any) tripped the deny-list.

No `git push` runs. No PR is opened. No deploy fires. The agent's local workspace is discarded at the end of the step, so the diff itself is not retrievable after the fact.

## Tuning

### Single-service projects (typical)

The defaults are sane. Bump `maxLinesChanged` to ~2000 if your project has large lockfile updates that aren't worth a separate change.

### Monorepos

A single agent step that touches one workspace package can easily hit 50 files. Increase both caps:

- `maxFilesChanged`: 60–80
- `maxLinesChanged`: 3000–5000

Add per-app globs to the deny list rather than raising the file cap globally — e.g. deny `**/apps/billing/**` so the agent stays out of billing code unless an operator explicitly relaxes the policy.

### "Tests are human-only"

Add `**/test/**` or `**/__tests__/**` to `deniedPaths`. The agent can still run tests (read), it just can't modify them. Pair with a separate test-writing agent that runs out-of-loop.

### Common globs

```
**/migrations/**     # DB migrations (default — keep this)
**/secrets*          # Credential filenames (default — keep this)
**/.env*             # Env files (default — keep this)
**/*.pem             # Private keys (default — keep this)
**/*.key             # Same (default — keep this)
**/Dockerfile        # Container changes are usually intentional human work
**/Procfile          # Same for Heroku-style process declarations
infra/**             # Terraform / Pulumi / etc.
**/CHANGELOG.md      # Avoid agent-authored changelog edits
```

## Interaction with other guardrails

- **Dry-run mode** (#284) short-circuits before the blast-radius check — a dry-run changeset doesn't push regardless of size, so the cap never fires for it.
- **Monthly spend cap** (#282) fires earlier (at agent-step entry), so a cap-hit run never produces a changeset at all.
- **Risk-score gate** (#286, upcoming) fires *after* this gate: blast-radius is binary (allow/reject), risk-score routes mid-risk changesets to a human approval queue rather than rejecting them.

## Diagnosing a false block

If a legitimate changeset gets blocked:

1. Open the changeset detail page — read the breakdown. Which limit fired?
2. If it's a deny-glob hit, look at the path that matched. Is the glob too broad?
3. If it's the line/file cap, decide whether to (a) raise the cap or (b) ask the agent (via `mergecrew.yaml`) to split work into multiple smaller changesets.
4. Tune under Settings → Guardrails → Blast-radius limits. The next run picks up the new values immediately.

## Related

- [Dry-run mode](09-dry-run.md) — evaluate the agent loop without remote effects.
- [Monthly LLM spend cap](08-monthly-spend-cap.md) — the cost-side guardrail that fires before blast-radius.
- [Auto-promote rules](../00-product/auto-promote.md) — uses similar glob syntax for the opposite purpose (allowing changesets to skip manual review).
