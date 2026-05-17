-- Promote runs + drop tracking on changesets (#471). Adds the audit
-- log for the cherry-pick engine plus three fields on changesets so
-- the promote digest can surface what shipped where and what was
-- dropped.

do $$ begin
  if not exists (select 1 from pg_type where typname = 'promote_run_status') then
    create type "promote_run_status" as enum ('pending', 'conflict', 'completed', 'failed');
  end if;
end $$;

create table if not exists "promote_runs" (
  "id"                     uuid not null,
  "organization_id"        uuid not null,
  "project_id"             uuid not null,
  "status"                 "promote_run_status" not null default 'pending',
  "release_ref"            text,
  "approved_changeset_ids" jsonb not null,
  "conflict"               jsonb,
  "failure_reason"         text,
  "created_at"             timestamp(6) with time zone not null default current_timestamp,
  "finished_at"            timestamp(6) with time zone,
  constraint "promote_runs_pkey" primary key ("id")
);

create index if not exists "promote_runs_project_created_idx"
  on "promote_runs" ("project_id", "created_at" desc);

alter table "promote_runs"
  add constraint "promote_runs_project_id_fkey"
  foreign key ("project_id") references "projects" ("id") on delete cascade on update cascade;

alter table "promote_runs" enable row level security;
alter table "promote_runs" force row level security;

drop policy if exists "tenant_isolation" on "promote_runs";
create policy "tenant_isolation" on "promote_runs"
  using (organization_id = (current_setting('app.org_id', true))::uuid)
  with check (organization_id = (current_setting('app.org_id', true))::uuid);

grant select, insert, update, delete on "promote_runs" to "mergecrew_app";

-- Changeset additions. The three columns sit on the existing row so
-- the digest UI can filter and the project page can show "shipped in
-- release X" without a join.
alter table "changesets"
  add column if not exists "last_promote_run_id" uuid,
  add column if not exists "dropped_at"          timestamp(6) with time zone,
  add column if not exists "drop_revert_pr_url"  text;

-- Soft FK — leave promote_runs in place if a changeset references one
-- that was deleted out from under it. The relation is decorative for
-- the audit view; correctness lives on the promote_runs row itself.
alter table "changesets"
  drop constraint if exists "changesets_last_promote_run_id_fkey";
alter table "changesets"
  add constraint "changesets_last_promote_run_id_fkey"
  foreign key ("last_promote_run_id") references "promote_runs" ("id") on delete set null on update cascade;

-- Partial index for the digest query: "active (not dropped) changesets
-- since the last promote run on this project." Hot path on the project
-- page once #472 lands.
create index if not exists "changesets_active_for_promote_idx"
  on "changesets" ("project_id", "updated_at" desc)
  where "dropped_at" is null;
