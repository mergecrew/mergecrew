-- Per-project SLO targets (V2.af / #745).
-- One row per SLO. The evaluator (worker-cron `sloEvaluatorTick`) reads
-- recent metrics_rollups for each enabled SLO, computes a state, and
-- emits a TimelineEvent of type `slo.transitioned` when the state
-- changes. State is not stored here — it's derived on read from the
-- timeline so the UI shows a single source of truth.

create table "project_slos" (
  "id"            uuid primary key default gen_random_uuid(),
  "organization_id" uuid not null,
  "project_id"    uuid not null,
  "name"          text not null,
  "metric"        text not null,
  "comparator"    text not null,
  "threshold"     numeric(12, 4) not null,
  "window_hours"  integer not null,
  "enabled"       boolean not null default true,
  "created_at"    timestamptz(6) not null default now(),
  "updated_at"    timestamptz(6) not null default now(),
  constraint "project_slos_project_fk"
    foreign key ("project_id") references "projects"("id") on delete cascade,
  constraint "project_slos_metric_chk"
    check ("metric" in ('stepPassRate', 'runFailureRate', 'p95StepMs', 'dailyCostUsd')),
  constraint "project_slos_comparator_chk"
    check ("comparator" in ('gte', 'lte')),
  constraint "project_slos_window_chk"
    check ("window_hours" between 1 and 720)
);

create index "project_slos_project_enabled_idx"
  on "project_slos" ("project_id", "enabled");

alter table "project_slos" enable row level security;
alter table "project_slos" force row level security;

create policy "tenant_isolation" on "project_slos"
  using (organization_id = (current_setting('app.org_id', true))::uuid)
  with check (organization_id = (current_setting('app.org_id', true))::uuid);
