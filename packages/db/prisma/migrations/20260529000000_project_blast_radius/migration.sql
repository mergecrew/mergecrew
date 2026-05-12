-- Per-project blast-radius limits (#285). Hard caps on what a single
-- agent run can change. Enforced post-agent / pre-push: an oversize or
-- denied-path changeset is marked `blocked` with a structured reason,
-- surfaced on the changeset detail page + inbox, and NOT pushed to the
-- remote.
--
-- Defaults are conservative: 25 files, 1000 lines, deny migrations and
-- credential-shaped paths. Operators can loosen or tighten under
-- Settings → Guardrails.

ALTER TABLE "projects"
  ADD COLUMN "max_files_changed" INTEGER NOT NULL DEFAULT 25,
  ADD COLUMN "max_lines_changed" INTEGER NOT NULL DEFAULT 1000,
  ADD COLUMN "denied_paths"      JSONB   NOT NULL DEFAULT '["**/migration*", "**/secrets*", "**/.env*", "**/*.pem", "**/*.key"]';

ALTER TYPE "changeset_status" ADD VALUE IF NOT EXISTS 'blocked';

ALTER TABLE "changesets"
  ADD COLUMN "blocked_reason" JSONB;
