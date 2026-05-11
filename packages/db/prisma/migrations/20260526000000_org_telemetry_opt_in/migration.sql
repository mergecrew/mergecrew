-- Anonymous-usage telemetry opt-in (#253). Off by default — even on
-- docker-compose.full.yml. When enabled, the telemetry package emits a
-- documented event schema (see docs/03-infrastructure/07-telemetry.md).
-- The install id is generated lazily when an org first turns telemetry
-- on; disabled orgs never pin an id at all.
ALTER TABLE "organizations"
  ADD COLUMN "telemetry_enabled" BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN "telemetry_install_id" UUID;
