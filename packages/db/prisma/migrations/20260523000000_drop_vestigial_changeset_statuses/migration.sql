-- Drop vestigial Changeset status enum values (#192).
--
-- The initial schema defined 12 ChangesetStatus values, but only 9 are
-- ever written by code. The other three — `flagged`, `awaiting_decision`,
-- `abandoned` — were never set anywhere (verified across apps + packages
-- before this migration was written).
--
-- Postgres has no `ALTER TYPE … DROP VALUE`, so we do the rename-create-
-- alter-drop dance. Wrapped in a transaction so a partial failure leaves
-- the schema intact.
--
-- This migration is safe ONLY because no row carries one of the dropped
-- values today. If you're applying this on top of a database where that
-- assumption no longer holds, the `ALTER TABLE … TYPE` will fail; remap
-- the offending rows first.

BEGIN;

CREATE TYPE "changeset_status_new" AS ENUM (
  'proposed',
  'building',
  'testing',
  'tests_failed',
  'pr_open',
  'dev_deployed',
  'promoted',
  'rolled_back',
  'deferred'
);

ALTER TABLE "changesets" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "changesets"
  ALTER COLUMN "status" TYPE "changeset_status_new"
  USING ("status"::text::"changeset_status_new");
ALTER TYPE "changeset_status" RENAME TO "changeset_status_old";
ALTER TYPE "changeset_status_new" RENAME TO "changeset_status";
DROP TYPE "changeset_status_old";
ALTER TABLE "changesets" ALTER COLUMN "status" SET DEFAULT 'proposed';

COMMIT;
