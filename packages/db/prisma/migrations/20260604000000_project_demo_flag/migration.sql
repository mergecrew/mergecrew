-- Per-org demo project flag (#437). Marks the seeded sample project so
-- the API can enforce read-only semantics (#438) and the UI can render
-- a "DEMO" chip + skip-demo affordances (#439). Existing `acme`-slug
-- projects (the global-seed demo) are backfilled as demo=true AND
-- renamed to `demo-saas` so the slug reads as obviously-a-demo in the
-- project list. Stale `/projects/acme` links 404 gracefully now (#435).

ALTER TABLE "projects"
  ADD COLUMN "demo" BOOLEAN NOT NULL DEFAULT FALSE;

UPDATE "projects"
  SET "demo" = TRUE, "slug" = 'demo-saas', "name" = 'Demo SaaS'
  WHERE "slug" = 'acme';
