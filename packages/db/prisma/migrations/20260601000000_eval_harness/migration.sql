-- Eval harness (V2.ab #299). EvalRun owns aggregate stats for one
-- pnpm-eval-run invocation (or nightly cron tick, or one half of an
-- A/B compare). EvalCase is the per-fixture row carrying the agent's
-- diff, snapshot result, cost, and latency.

CREATE TABLE "eval_runs" (
  "id"               UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id"  UUID    NOT NULL,
  "llm_profile_id"   UUID,
  "source"           TEXT    NOT NULL,
  "started_at"       TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "finished_at"      TIMESTAMPTZ(6),
  "total_cases"      INTEGER NOT NULL DEFAULT 0,
  "pass_count"       INTEGER NOT NULL DEFAULT 0,
  "fail_count"       INTEGER NOT NULL DEFAULT 0,
  "error_count"      INTEGER NOT NULL DEFAULT 0,
  "total_usd"        DECIMAL(12, 6) NOT NULL DEFAULT 0,
  "total_latency_ms" INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX "eval_runs_organization_id_started_at_idx"
  ON "eval_runs"("organization_id", "started_at" DESC);

CREATE TABLE "eval_cases" (
  "id"            UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  "eval_run_id"   UUID    NOT NULL REFERENCES "eval_runs"("id") ON DELETE CASCADE,
  "fixture_id"    TEXT    NOT NULL,
  "status"        TEXT    NOT NULL,
  "agent_diff"    TEXT,
  "error_message" TEXT,
  "usd_estimate"  DECIMAL(12, 6) NOT NULL DEFAULT 0,
  "latency_ms"    INTEGER NOT NULL DEFAULT 0,
  "finished_at"   TIMESTAMPTZ(6) NOT NULL DEFAULT NOW()
);

CREATE INDEX "eval_cases_eval_run_id_idx" ON "eval_cases"("eval_run_id");
