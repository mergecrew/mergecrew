-- Risk-score gate (#286). Post-push, the runner computes a weighted
-- score per changeset:
--   score = filesChanged + linesChanged * 0.1 + sensitivePathHits * 10
-- and surfaces changesets above `auto_merge_threshold` to the inbox as
-- `risk_score_high` while suppressing auto-promote. `sensitive_paths`
-- is the picomatch glob list flagging files where a single touch is
-- worth a human review (config, auth, schema).
--
-- Threshold defaults to 50: 25 files + 250 LOC + zero sensitive hits
-- crosses the line, but a focused refactor of 5 files / 200 LOC stays
-- under it. Tune under Settings → Guardrails.

ALTER TABLE "projects"
  ADD COLUMN "auto_merge_threshold" INTEGER NOT NULL DEFAULT 50,
  ADD COLUMN "sensitive_paths" JSONB NOT NULL DEFAULT '["**/config/**", "**/auth/**", "**/*.sql"]';

ALTER TABLE "changesets"
  ADD COLUMN "risk_score" DOUBLE PRECISION,
  ADD COLUMN "risk_score_breakdown" JSONB;
