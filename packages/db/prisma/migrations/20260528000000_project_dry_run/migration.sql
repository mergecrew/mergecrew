-- Per-project dry-run mode (#284). When enabled, the agent loop still
-- produces a Changeset row + diff but the runner skips git push, PR
-- creation, and deploy. The `is_dry_run` column on changesets records
-- the project's setting at the moment the changeset was produced, so a
-- changeset's mode doesn't change when the project flag is later flipped.

ALTER TABLE "projects"
  ADD COLUMN "dry_run" BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE "changesets"
  ADD COLUMN "is_dry_run" BOOLEAN NOT NULL DEFAULT FALSE;
