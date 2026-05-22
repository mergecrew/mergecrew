-- Pre-aggregated telemetry buckets (V2.af / #742).
-- One row per (org, project?, granularity, bucket). project_id is NULL for
-- org-wide rollups; tenant_isolation RLS still binds on organization_id.
-- The worker-cron `metricsRollupTick` UPSERTs into this table; metrics
-- pages, SLO evaluator, and health badges read from it.

create table "metrics_rollups" (
  "id"              uuid primary key default gen_random_uuid(),
  "organization_id" uuid           not null,
  "project_id"      uuid,
  "granularity"     text           not null,
  "bucket"          timestamptz(6) not null,
  "runs_started"    integer        not null default 0,
  "runs_completed"  integer        not null default 0,
  "runs_failed"     integer        not null default 0,
  "steps_run"       integer        not null default 0,
  "steps_passed"    integer        not null default 0,
  "p50_step_ms"     integer        not null default 0,
  "p95_step_ms"     integer        not null default 0,
  "llm_tokens_in"   bigint         not null default 0,
  "llm_tokens_out"  bigint         not null default 0,
  "cost_usd_cents"  bigint         not null default 0,
  "computed_at"     timestamptz(6) not null default now(),
  constraint "metrics_rollups_granularity_chk"
    check ("granularity" in ('hour', 'day'))
);

-- Partial unique indexes: one row per bucket for the org-wide branch
-- (project_id IS NULL), and one row per bucket per project for the
-- project-scoped branch. UPSERT keys against these.
create unique index "metrics_rollups_org_proj_grain_bucket_uniq"
  on "metrics_rollups" ("organization_id", "project_id", "granularity", "bucket")
  where "project_id" is not null;

create unique index "metrics_rollups_org_grain_bucket_uniq"
  on "metrics_rollups" ("organization_id", "granularity", "bucket")
  where "project_id" is null;

create index "metrics_rollups_org_grain_bucket_desc_idx"
  on "metrics_rollups" ("organization_id", "granularity", "bucket" desc);

create index "metrics_rollups_proj_grain_bucket_desc_idx"
  on "metrics_rollups" ("project_id", "granularity", "bucket" desc)
  where "project_id" is not null;

alter table "metrics_rollups" enable row level security;
alter table "metrics_rollups" force row level security;

create policy "tenant_isolation" on "metrics_rollups"
  using (organization_id = (current_setting('app.org_id', true))::uuid)
  with check (organization_id = (current_setting('app.org_id', true))::uuid);
