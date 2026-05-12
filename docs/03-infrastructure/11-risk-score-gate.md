# Risk-score gate

Blast-radius limits are binary — over the cap and the changeset never reaches the remote. But most real changesets fall in the middle: they're not unsafe enough to refuse outright, just large or sensitive enough that a human should look before they auto-merge. The risk-score gate covers that middle ground.

## The score

For every changeset that opens a PR, the runner computes:

```
score = filesChanged + linesChanged × 0.1 + sensitivePathHits × 10
```

- `filesChanged`: distinct paths in the diff (binaries and renames count).
- `linesChanged`: sum of additions + deletions across the diff.
- `sensitivePathHits`: count of changed paths that match any glob in `Project.sensitivePaths`. Each match contributes 10 to the score, so even a 1-file 5-line PR can trip the gate if it touches a flagged path.

We picked the weights to be readable, not optimal. The number on the inbox card should make obvious sense to an operator reading it cold — "yeah, 12 files plus 3 sensitive hits, that's worth a look."

## The threshold

`Project.autoMergeThreshold` — integer, default **50**. A changeset whose score is **strictly greater than** the threshold:

1. Lands in the inbox as an `ApprovalRequest` with `reason = 'risk_score_high'` and the breakdown attached to `details`.
2. Is **not** considered for auto-promote, even if a matching rule exists. The PR stays open until a human acts.

Calibration:

- **50** (default): a typical agent run that touches 5–10 files and 100–300 lines stays under. A refactor touching 30 files or a 200-LOC change that hits a sensitive path crosses it.
- **20**: cautious. Most non-trivial changesets need approval. Use during the first few weeks of running mergecrew against a real codebase.
- **200**: permissive. Only large diffs or many-sensitive-path-hit changes are gated. Use once you trust the agents on this project.
- **0**: every changeset needs approval. Effectively disables auto-promote.

## Sensitive paths

`Project.sensitivePaths` is an OR-list of picomatch globs. The defaults match the kinds of files where a single touch usually deserves a second look:

```
**/config/**     # Application config — env-shaped knobs, feature flags
**/auth/**       # Auth code (sessions, JWT, OAuth flows)
**/*.sql         # Hand-written SQL, including schema changes outside migrations/
```

Add patterns to fit your codebase:

```
**/billing/**     # Anything money-touching
**/payments/**    # Same
**/permissions/** # Access-control rules
infra/**          # Terraform / Pulumi / etc.
**/Dockerfile     # Container build
```

Removing a default glob is fine if it doesn't apply to your codebase (e.g. no `auth/` directory). Removing all of them just makes the gate fire on diff size alone.

## What "approve" / "reject" mean

Today the resolve actions on the inbox are bookkeeping, not automation:

- **Approve**: the approval is marked resolved, the event is logged, and the changeset stays in `pr_open`. The operator then goes to the PR on GitHub and merges via the normal flow.
- **Reject**: the approval is marked resolved with `reject`. The changeset stays in `pr_open`; rejecting the approval is a signal, not an enforcement action — close the PR manually or let it age out.

A future issue (V2.ab) will wire approve → auto-merge and reject → PR close, but the V2.aa scope deliberately keeps the gate as visibility-only so it can't merge anything you didn't explicitly merge yourself.

## Interaction with other guardrails

- **Blast-radius limits** (#285) fire first. A changeset blocked by blast-radius never produces an `ApprovalRequest` because the push step never runs.
- **Auto-promote rules** (#154) used to be the only thing that could merge a changeset without a human. The risk-score gate now intercepts: a high-score changeset skips auto-promote evaluation entirely.
- **Dry-run mode** (#284) short-circuits before either gate. Dry-run changesets don't push, so risk-score never runs on them.

## Diagnosing a stuck inbox

If the same changeset keeps appearing in the inbox across runs:

1. Open the changeset detail page — does the diff actually deserve review?
2. If yes: approve / reject, then merge on GitHub. Don't raise the threshold unless the *category* of changeset is fine to auto-merge.
3. If no (false positive): inspect the score breakdown on the inbox card. Which component is dominant?
   - `filesChanged` heavy → maybe you have a "rename" run that touched many files but is mechanically safe. Add an AutoPromoteRule to capture it.
   - `linesChanged` heavy → likely a lockfile or generated-file diff. Either add an AutoPromoteRule or add the path to `deniedPaths` so the agent stops generating it.
   - `sensitiveHits` heavy → the sensitive-paths list is too broad. Tighten it.

## Related

- [Blast-radius limits](10-blast-radius.md) — the binary gate that fires before this one.
- [Dry-run mode](09-dry-run.md) — evaluate the agent loop without remote effects.
- [Auto-promote rules](../00-product/auto-promote.md) — the allowlist mechanism the risk-score gate overrides.
