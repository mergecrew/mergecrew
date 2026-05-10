-- Persisted node positions for the visual lifecycle editor
-- (V2.1 phase 2, #195). Keyed on (project_id, workflow_id) — NOT on
-- Lifecycle — so positions survive the row-replacing version bumps
-- every YAML edit produces.
create table "lifecycle_graph_layouts" (
  "id" uuid not null,
  "organization_id" uuid not null,
  "project_id" uuid not null,
  "workflow_id" text not null,
  "x" integer not null,
  "y" integer not null,
  "updated_at" timestamp(6) with time zone not null default current_timestamp,
  constraint "lifecycle_graph_layouts_pkey" primary key ("id")
);

create unique index if not exists "lifecycle_graph_layouts_project_id_workflow_id_key"
  on "lifecycle_graph_layouts" ("project_id", "workflow_id");

create index if not exists "lifecycle_graph_layouts_organization_id_project_id_idx"
  on "lifecycle_graph_layouts" ("organization_id", "project_id");

alter table "lifecycle_graph_layouts"
  add constraint "lifecycle_graph_layouts_project_id_fkey"
  foreign key ("project_id") references "projects" ("id") on delete cascade on update cascade;

alter table "lifecycle_graph_layouts" enable row level security;
alter table "lifecycle_graph_layouts" force row level security;

drop policy if exists "tenant_isolation" on "lifecycle_graph_layouts";
create policy "tenant_isolation" on "lifecycle_graph_layouts"
  using (organization_id = (current_setting('app.org_id', true))::uuid)
  with check (organization_id = (current_setting('app.org_id', true))::uuid);

grant select, insert, update, delete on "lifecycle_graph_layouts" to "mergecrew_app";
