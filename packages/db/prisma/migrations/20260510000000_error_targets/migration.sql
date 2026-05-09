-- error_targets: per-project error-tracker integration (Sentry, etc.).
create table if not exists "error_targets" (
  "id" uuid not null,
  "organization_id" uuid not null,
  "project_id" uuid not null,
  "adapter_id" text not null,
  "config" jsonb not null,
  "created_at" timestamp(6) with time zone not null default current_timestamp,
  "updated_at" timestamp(6) with time zone not null default current_timestamp,
  constraint "error_targets_pkey" primary key ("id")
);

create unique index if not exists "error_targets_project_id_key" on "error_targets" ("project_id");

alter table "error_targets"
  add constraint "error_targets_project_id_fkey"
  foreign key ("project_id") references "projects" ("id") on delete cascade on update cascade;

alter table "error_targets" enable row level security;
alter table "error_targets" force row level security;

drop policy if exists "tenant_isolation" on "error_targets";
create policy "tenant_isolation" on "error_targets"
  using (organization_id = (current_setting('app.org_id', true))::uuid)
  with check (organization_id = (current_setting('app.org_id', true))::uuid);

grant select, insert, update, delete on "error_targets" to "mergecrew_app";
