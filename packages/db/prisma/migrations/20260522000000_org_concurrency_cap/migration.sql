-- Per-org concurrency cap (V1.3, #9).
--
-- The orchestrator counts agent_steps with status in ('pending','running')
-- and defers new dispatches when the count is at or above this cap. This
-- protects shared runner capacity from being monopolized by one tenant
-- (e.g. an org with 100 projects all scheduled at midnight starving a
-- single-project tenant on a small fleet).
--
-- Default 4 mirrors the runner's per-process BullMQ concurrency. Set 0
-- to disable enforcement.
alter table "organizations"
  add column if not exists "org_concurrency_cap" integer not null default 4;
