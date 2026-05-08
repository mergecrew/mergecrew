create table if not exists "org_lifecycle_templates" (
  "id" uuid not null,
  "organization_id" uuid not null,
  "name" text not null default 'default',
  "source_yaml" text not null,
  "parsed" jsonb not null,
  "created_at" timestamp(6) with time zone not null default current_timestamp,
  "updated_at" timestamp(6) with time zone not null default current_timestamp,
  constraint "org_lifecycle_templates_pkey" primary key ("id")
);

create unique index if not exists "org_lifecycle_templates_org_name_key"
  on "org_lifecycle_templates" ("organization_id", "name");

alter table "org_lifecycle_templates"
  add constraint "org_lifecycle_templates_organization_id_fkey"
  foreign key ("organization_id") references "organizations" ("id") on delete cascade on update cascade;

alter table "org_lifecycle_templates" enable row level security;
alter table "org_lifecycle_templates" force row level security;

drop policy if exists "tenant_isolation" on "org_lifecycle_templates";
create policy "tenant_isolation" on "org_lifecycle_templates"
  using (organization_id = (current_setting('app.org_id', true))::uuid)
  with check (organization_id = (current_setting('app.org_id', true))::uuid);

grant select, insert, update, delete on "org_lifecycle_templates" to "mergecrew_app";
