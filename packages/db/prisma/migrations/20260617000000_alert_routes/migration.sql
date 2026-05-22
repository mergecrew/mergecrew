-- Alert routing matrix (V2.af / #749).
-- Maps event kinds (digest.daily, run.failed, slo.breaching,
-- slo.recovered) to delivery channels (slack, email-user, none).
-- The dispatcher reads this table for every emitted event so changes
-- take effect on the next event without restart.

create table "alert_routes" (
  "id"              uuid primary key default gen_random_uuid(),
  "organization_id" uuid           not null,
  "event_kind"      text           not null,
  "channels"        text[]         not null default '{}',
  "created_at"      timestamptz(6) not null default now(),
  "updated_at"      timestamptz(6) not null default now(),
  constraint "alert_routes_event_kind_chk"
    check ("event_kind" in ('digest.daily', 'run.failed', 'slo.breaching', 'slo.recovered')),
  constraint "alert_routes_org_kind_uniq"
    unique ("organization_id", "event_kind")
);

create index "alert_routes_org_idx"
  on "alert_routes" ("organization_id");

alter table "alert_routes" enable row level security;
alter table "alert_routes" force row level security;

create policy "tenant_isolation" on "alert_routes"
  using (organization_id = (current_setting('app.org_id', true))::uuid)
  with check (organization_id = (current_setting('app.org_id', true))::uuid);
