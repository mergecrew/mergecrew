# One-click rollback

Even with monthly caps, dry-run, blast-radius, and risk-score gates, the wrong thing eventually merges. When it does, the only thing that matters is a clear button labeled "undo." Mergecrew exposes that as a one-click rollback on the changeset detail page.

## What it does

When an admin clicks **Roll back** on a merged changeset:

1. The API loads the changeset and confirms `status = 'promoted'` and a real `prNumber`.
2. The VCS adapter's `revertPullRequest` opens a `git revert` PR against the project's default branch. For GitHub that's the equivalent of `git revert <merge-sha>` plus a PR with the standard `Revert "<original title>"` boilerplate.
3. The changeset row is updated to `status = 'rolled_back'` with the new `revertPrNumber` and `revertPrUrl` stamped on. The detail page shows a link to the revert PR.
4. An `AuditLogEntry` is written with `action = 'changeset.rollback_initiated'` — actor, original PR number, revert PR number + URL, and the list of migration files touched (if any).
5. A `CHANGESET_ROLLED_BACK` timeline event is emitted with `source = 'one_click'`.

The revert PR is *not* auto-merged. An operator still reviews + merges it through the usual flow. That's deliberate: if the original change introduced a bug that needed fixing forward instead, you might want to close the revert PR rather than merge it.

## Who can do it

Admin role only. Operator-tier accounts can promote and decide but not roll back — a rollback can have wider downstream consequences (deploy reverts, dependent services), so we keep the trigger on the smallest authorized audience.

## The migrations caveat

If the original changeset's PR touched any path matching `**/migrations/**` or `**/prisma/migrations/**`, the API response flags `migrationsWarning: true` with the matched file list. The UI shows a prominent warning before the operator confirms:

> If the original changeset touched database migrations, you'll need to handle the schema reversal manually — review the revert PR before merging it.

`git revert` produces a commit that undoes the *code* of the migration file but **does not run a down-migration**. A typical Prisma migration adding a column is reverted by:

1. The `git revert` PR (removes the migration file from the tree)
2. A new follow-up migration that drops the column on existing environments

The rollback button only does step 1. Step 2 is operator work — read the revert PR's diff, write the inverse migration, and ship it as a separate change.

## What rollback can't do

- **Already-deployed side effects.** If the original change ran a one-shot data migration script, populated a new feature flag, or kicked off a third-party integration, the revert PR doesn't unwind those.
- **External system state.** Webhooks fired by the original change have already fired. The revert PR is just code; if you need to also undo a Slack notification or a Linear ticket update, that's a separate manual step.
- **Cross-repo dependencies.** Mergecrew rolls back one repo at a time. If the original change required a coordinated update to a downstream service, you'll need to either roll back that service too (also via mergecrew if it's also a managed project) or accept temporary inconsistency.

## When NOT to use rollback

- The original change introduced a bug, but the bug is a one-line fix-forward. Just open another PR.
- The original change is fine but produced unexpected emergent behavior in production. Investigate first — rollback may be cheaper but fixing the underlying issue is durable.
- The original change has been in production long enough that its data is depended on by downstream consumers. Revert PRs at this stage usually cause more problems than they solve.

## Audit trail

Every rollback writes:

- `audit_log_entries` row with action `changeset.rollback_initiated`
- `timeline_events` row with type `CHANGESET_ROLLED_BACK`, payload includes `source: 'one_click'` (so we can distinguish from any future automated-rollback sources)
- `changesets.revert_pr_number` + `changesets.revert_pr_url` columns updated

The rollback button is disabled on changesets that already have `revertPrNumber` set, so you can't accidentally fire two revert PRs for the same change.

## Related

- [Operator runbook](05-operator-runbook.md) — broader diagnostic flows.
- [Risk-score gate](11-risk-score-gate.md) — the upstream gate meant to catch the kinds of changesets you'd later want to roll back.
- [Auto-promote rules](../00-product/auto-promote.md) — the allowlist mechanism whose mistakes rollback is meant to clean up.
