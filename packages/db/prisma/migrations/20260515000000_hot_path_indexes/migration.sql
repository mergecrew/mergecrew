-- Hot-path indexes spotted during the V1.10 schema audit (#123).
-- All three are pure additions (no shape change, no FK).
--
-- Note for prod operators: Prisma's migration runner wraps each file in a
-- transaction, so CONCURRENTLY isn't usable here. On a non-trivial dataset
-- you'll want to drop these and recreate with CONCURRENTLY out-of-band:
--
--   create index concurrently <name> on <table> (...);
--
-- Table sizes today are small enough that the brief AccessExclusiveLock is
-- a non-event; revisit once daily_runs > 100k rows.

-- daily_runs: orchestrator inflight check filters by status before time;
-- existing (project_id, scheduled_at) needed an index-only-scan friend.
create index if not exists
  "daily_runs_project_id_status_scheduled_at_idx"
  on "daily_runs" ("project_id", "status", "scheduled_at" desc);

-- schedules: worker-cron tick scans where enabled = true every minute.
create index if not exists
  "schedules_enabled_idx"
  on "schedules" ("enabled");

-- timeline_events: SSE replay seeks (daily_run_id, id > marker).
create index if not exists
  "timeline_events_daily_run_id_id_idx"
  on "timeline_events" ("daily_run_id", "id");
