# Dry-run mode

Dry-run mode is the lowest-risk way to evaluate Mergecrew against an existing codebase. With the toggle on, every part of the agent loop runs end-to-end **except** the three remote-effect stages: `git push`, PR creation, and deploy. You see exactly what the agent *would* do, without anything landing on the remote.

## When to use it

- **First week on a new repo.** Run with `dryRun: true` for the first 5–10 daily runs. Read the diffs, refine the agent prompts and lifecycle, then flip the toggle off when the output is consistently good.
- **Lifecycle changes.** After editing `mergecrew.yaml` (new agents, changed budgets, new sensitive paths), flip on dry-run for a run or two to confirm the change does what you expect.
- **Provider switching.** Comparing Anthropic vs OpenAI vs Bedrock on your stack — keep the changesets virtual until you've decided which provider behaves better.

## What the runner does in dry-run

1. The agent step runs normally: every skill, every commit, every tool call is real.
2. The `Changeset` row is created with `isDryRun: true`. It has the branch name, the commit title, the why-paragraph, the test summary, the cost estimate — same as a normal changeset.
3. The runner reaches the post-loop "open PR" step and **short-circuits**: no `vcs.push`, no `vcs.openPullRequest`, no `deploy.triggerDeploy`.
4. The transcript still lands in the configured transcript store, so you can audit every model turn and tool call.

The changeset shows up on the project's Changesets page with an amber **DRY RUN** badge. The detail page calls it out explicitly.

## What dry-run does *not* do

- It does not push the branch to the remote. Once the runner finishes, the in-process workspace is discarded, so the only persistent record of "what the diff was" is what the agent wrote into the transcript + the changeset row's metadata.
- It does not let you "promote" an old dry-run changeset to a real PR after the fact. To ship the change for real you turn off dry-run and let the next run produce the equivalent changeset against current HEAD. A re-from-blob promote feature is on the V2.aa roadmap but not in this issue's scope.
- It does not save LLM cost. The agent loop runs to completion; only the remote-side effects are skipped. Pair dry-run with a tight `monthlySpendCapUsd` (see [08-monthly-spend-cap.md](08-monthly-spend-cap.md)) while you're evaluating.

## Toggling it

- **UI**: Project settings → "Guardrails" → "Dry-run mode" checkbox.
- **API**: `PATCH /v1/orgs/:slug/projects/:projectSlug` with `{ "dryRun": true }`. Operator role required.
- **SQL** (for break-glass): `update projects set dry_run = true where id = '<project-id>';`

Toggling takes effect on the next agent step entry — there's no cache to bust, no orchestrator restart. A run mid-flight when you flip the toggle finishes under whatever mode it started in.

## Related

- [Monthly LLM spend cap](08-monthly-spend-cap.md) — pair with dry-run during evaluation to bound cost.
- [Operator runbook](05-operator-runbook.md) — diagnostic flows for the non-dry-run failure modes.
