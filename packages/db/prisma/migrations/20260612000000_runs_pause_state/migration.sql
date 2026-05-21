-- Operator-controlled run kill switch (#625).
--
-- Same shape on both scopes: nullable timestamp + free-form reason + actor.
-- Set = paused; null = active. Org-scope pause beats project-scope pause and
-- is checked at three points (worker-cron tick, RunService.runNow,
-- orchestrator.handleRunDue). In-flight runs continue — pause only blocks
-- *new* run dispatch; killing an active run still goes through the existing
-- Cancel button on the run page.
--
-- Why not reuse Schedule.enabled: that flag is "manual-only mode" (no cron,
-- Run now still works). Pause is the kill switch (blocks both cron AND
-- manual). Different concepts, kept separate so toggling one doesn't
-- silently change the other's meaning.

alter table "projects"
  add column if not exists "runs_paused_at"          timestamptz(6),
  add column if not exists "runs_pause_reason"       text,
  add column if not exists "runs_paused_by_user_id"  uuid;

alter table "organizations"
  add column if not exists "runs_paused_at"          timestamptz(6),
  add column if not exists "runs_pause_reason"       text,
  add column if not exists "runs_paused_by_user_id"  uuid;

-- worker-cron tick scans schedules then short-circuits on paused projects.
-- Partial index keeps it cheap: typically zero rows match (most projects
-- are not paused) and the index is consulted on every tick.
create index if not exists "projects_runs_paused_at_idx"
  on "projects" ("runs_paused_at") where "runs_paused_at" is not null;
