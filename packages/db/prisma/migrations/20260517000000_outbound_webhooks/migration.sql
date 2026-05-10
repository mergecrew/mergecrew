-- Outbound webhooks (#141) + per-attempt delivery log.
-- Signed deliveries (#142) ship from day one — there is no unsigned mode.

create table if not exists "outbound_webhooks" (
  "id"                  uuid not null,
  "organization_id"     uuid not null,
  "url"                 text not null,
  "secret"              text not null,
  "events"              jsonb not null default '[]'::jsonb,
  "enabled"             boolean not null default true,
  "created_by_user_id"  uuid,
  "created_at"          timestamp(6) with time zone not null default current_timestamp,
  "last_delivered_at"   timestamp(6) with time zone,
  "failure_count"       integer not null default 0,
  constraint "outbound_webhooks_pkey" primary key ("id")
);

create index if not exists "outbound_webhooks_organization_id_idx" on "outbound_webhooks" ("organization_id");

alter table "outbound_webhooks"
  add constraint "outbound_webhooks_organization_id_fkey"
  foreign key ("organization_id") references "organizations" ("id") on delete cascade on update cascade;

alter table "outbound_webhooks" enable row level security;
alter table "outbound_webhooks" force row level security;

drop policy if exists "tenant_isolation" on "outbound_webhooks";
create policy "tenant_isolation" on "outbound_webhooks"
  using (organization_id = (current_setting('app.org_id', true))::uuid)
  with check (organization_id = (current_setting('app.org_id', true))::uuid);

grant select, insert, update, delete on "outbound_webhooks" to "mergecrew_app";


create table if not exists "webhook_deliveries" (
  "id"             uuid not null,
  "webhook_id"     uuid not null,
  "delivery_uuid"  uuid not null,
  "event_type"     text not null,
  "status_code"    integer,
  "attempt"        integer not null default 1,
  "occurred_at"    timestamp(6) with time zone not null default current_timestamp,
  "error_message"  text,
  constraint "webhook_deliveries_pkey" primary key ("id")
);

create unique index if not exists "webhook_deliveries_delivery_uuid_key" on "webhook_deliveries" ("delivery_uuid");
create index if not exists "webhook_deliveries_webhook_id_occurred_at_idx" on "webhook_deliveries" ("webhook_id", "occurred_at" desc);

alter table "webhook_deliveries"
  add constraint "webhook_deliveries_webhook_id_fkey"
  foreign key ("webhook_id") references "outbound_webhooks" ("id") on delete cascade on update cascade;

-- Deliveries inherit RLS from the parent webhook via the FK chain in
-- queries; we still enable RLS for defense-in-depth. Joins from API
-- routes always go via the webhook row, which is org-scoped.
alter table "webhook_deliveries" enable row level security;
alter table "webhook_deliveries" force row level security;

drop policy if exists "tenant_isolation" on "webhook_deliveries";
create policy "tenant_isolation" on "webhook_deliveries"
  using (
    exists (
      select 1 from "outbound_webhooks" w
      where w.id = webhook_deliveries.webhook_id
        and w.organization_id = (current_setting('app.org_id', true))::uuid
    )
  );

grant select, insert, update, delete on "webhook_deliveries" to "mergecrew_app";
