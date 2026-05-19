-- Per-run outbound network attempts (#576).
-- One row per allow/deny decision; aggregated server-side for the
-- run-detail "Network" section so operators can see what each build
-- tried to reach.
create table "egress_events" (
  "id"              uuid primary key default gen_random_uuid(),
  "organization_id" uuid not null,
  "daily_run_id"    uuid not null,
  "agent_step_id"   uuid,
  "source"          text not null,
  "origin"          text,
  "host"            text not null,
  "port"            integer,
  "method"          text,
  "decision"        text not null,
  "reason"          text not null,
  "mode"            text not null default 'enforced',
  "occurred_at"     timestamptz(6) not null default now(),
  constraint "egress_events_daily_run_fk"
    foreign key ("daily_run_id") references "daily_runs"("id") on delete cascade,
  constraint "egress_events_agent_step_fk"
    foreign key ("agent_step_id") references "agent_steps"("id") on delete set null
);

create index "egress_events_run_time_idx"
  on "egress_events" ("daily_run_id", "occurred_at" desc);

create index "egress_events_run_decision_host_idx"
  on "egress_events" ("daily_run_id", "decision", "host");

alter table "egress_events" enable row level security;
alter table "egress_events" force row level security;

create policy "tenant_isolation" on "egress_events"
  using (organization_id = (current_setting('app.org_id', true))::uuid)
  with check (organization_id = (current_setting('app.org_id', true))::uuid);
