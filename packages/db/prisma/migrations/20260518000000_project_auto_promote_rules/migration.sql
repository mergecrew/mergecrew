-- Auto-promote rule storage on Project (#152, builds on #150).
-- Empty array = no auto-promotion; every changeset still goes through the
-- manual gate. The application validates each entry against the Zod
-- AutoPromoteRule schema before writing — the column is intentionally
-- jsonb (no DB-side check constraint) since the rule shape will evolve.

alter table "projects"
  add column if not exists "auto_promote_rules" jsonb not null default '[]'::jsonb;
