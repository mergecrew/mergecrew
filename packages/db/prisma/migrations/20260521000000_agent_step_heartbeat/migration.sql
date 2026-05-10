-- Liveness heartbeat for in-flight agent steps (#10 V1.4).
--
-- The runner stamps `heartbeat_at` periodically (default every 15s, see
-- RUNNER_HEARTBEAT_INTERVAL_MS) while a step executes. The orchestrator's
-- heartbeat sweeper scans for `status='running' AND heartbeat_at < now() - 90s`
-- and re-dispatches the step (with a fresh heartbeat) up to a small attempt
-- cap, after which the step is marked failed with reason 'runner_dead'.
--
-- The compound (status, heartbeat_at) index keeps the sweeper's scan cheap
-- even with thousands of historical agent_steps rows; pending/completed
-- rows have heartbeat_at = NULL and don't bloat the heartbeat dimension.
alter table "agent_steps"
  add column if not exists "heartbeat_at" timestamptz;

create index if not exists "agent_steps_status_heartbeat_at_idx"
  on "agent_steps" ("status", "heartbeat_at");
