-- Promotion strategy per project (#470). Captures *how* dev graduates
-- to prod after the cherry-pick engine (#471) builds a release ref.
-- One row per project, kind picks the shape, other columns are
-- per-kind (release_branch + prod_url for auto_deploy / manual_workflow,
-- workflow_* columns for manual_workflow, tag_pattern for tag_driven).
-- Stricter validation lives in the API service so the picker UX can
-- change without another migration each time.

do $$ begin
  if not exists (select 1 from pg_type where typname = 'promotion_strategy_kind') then
    create type "promotion_strategy_kind" as enum (
      'auto_deploy',
      'manual_workflow',
      'tag_driven',
      'deferred'
    );
  end if;
end $$;

create table if not exists "promotion_strategies" (
  "id"                uuid not null,
  "organization_id"   uuid not null,
  "project_id"        uuid not null,
  "kind"              "promotion_strategy_kind" not null,
  "release_branch"    text,
  "workflow_filename" text,
  "env_input_key"     text,
  "env_input_value"   text,
  "tag_pattern"       text,
  "prod_url"          text,
  "created_at"        timestamp(6) with time zone not null default current_timestamp,
  "updated_at"        timestamp(6) with time zone not null default current_timestamp,
  constraint "promotion_strategies_pkey" primary key ("id")
);

create unique index if not exists "promotion_strategies_project_id_key"
  on "promotion_strategies" ("project_id");

alter table "promotion_strategies"
  add constraint "promotion_strategies_project_id_fkey"
  foreign key ("project_id") references "projects" ("id") on delete cascade on update cascade;

alter table "promotion_strategies" enable row level security;
alter table "promotion_strategies" force row level security;

drop policy if exists "tenant_isolation" on "promotion_strategies";
create policy "tenant_isolation" on "promotion_strategies"
  using (organization_id = (current_setting('app.org_id', true))::uuid)
  with check (organization_id = (current_setting('app.org_id', true))::uuid);

grant select, insert, update, delete on "promotion_strategies" to "mergecrew_app";
