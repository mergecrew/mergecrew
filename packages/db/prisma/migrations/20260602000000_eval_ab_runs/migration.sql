-- Eval A/B compare runs (V2.ab #302). Wraps two parent EvalRuns so the
-- compare page knows which two runs to render side-by-side, plus the
-- LLM profile id each side used. Children reference the parent
-- implicitly via `source = 'ab'` on EvalRun.

CREATE TABLE "eval_ab_runs" (
  "id"               UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id"  UUID    NOT NULL,
  "profile_a_id"     UUID    NOT NULL,
  "profile_b_id"     UUID    NOT NULL,
  "run_a_id"         UUID    NOT NULL,
  "run_b_id"         UUID    NOT NULL,
  "started_at"       TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "finished_at"      TIMESTAMPTZ(6)
);

CREATE INDEX "eval_ab_runs_organization_id_started_at_idx"
  ON "eval_ab_runs"("organization_id", "started_at" DESC);
