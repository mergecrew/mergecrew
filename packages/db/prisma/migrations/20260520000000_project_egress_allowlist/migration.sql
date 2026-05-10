-- Per-project egress host allowlist for agent skills (#10).
-- NULL = no restriction (back-compat); [] = block all; otherwise host
-- patterns. Stored as jsonb so the application can validate shape.
alter table "projects"
  add column if not exists "egress_allowlist" jsonb;
