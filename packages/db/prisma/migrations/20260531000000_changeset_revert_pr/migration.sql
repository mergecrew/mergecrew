-- One-click rollback target (#287). When an admin rolls back a merged
-- changeset we open a `git revert` PR via the VCS adapter and stamp
-- its number + URL here. Lets the detail page link to the active
-- revert without re-querying the host.
ALTER TABLE "changesets"
  ADD COLUMN "revert_pr_number" INTEGER,
  ADD COLUMN "revert_pr_url"    TEXT;
