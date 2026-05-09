-- changeset_comments: reviewer comments on pending changesets, anchored
-- to a file + line range in the diff. Threaded via parent_id self-FK.

create table if not exists "changeset_comments" (
  "id" uuid not null,
  "organization_id" uuid not null,
  "changeset_id" text not null,
  "user_id" uuid not null,
  "file_path" text not null,
  "line_range" jsonb,
  "body" text not null,
  "parent_id" uuid,
  "resolved_at" timestamp(6) with time zone,
  "created_at" timestamp(6) with time zone not null default current_timestamp,
  "updated_at" timestamp(6) with time zone not null default current_timestamp,
  constraint "changeset_comments_pkey" primary key ("id")
);

alter table "changeset_comments"
  add constraint "changeset_comments_changeset_id_fkey"
  foreign key ("changeset_id") references "changesets" ("id") on delete cascade on update cascade;

alter table "changeset_comments"
  add constraint "changeset_comments_user_id_fkey"
  foreign key ("user_id") references "users" ("id") on delete restrict on update cascade;

alter table "changeset_comments"
  add constraint "changeset_comments_parent_id_fkey"
  foreign key ("parent_id") references "changeset_comments" ("id") on delete set null on update cascade;

create index if not exists "changeset_comments_changeset_id_file_path_created_at_idx"
  on "changeset_comments" ("changeset_id", "file_path", "created_at");

alter table "changeset_comments" enable row level security;
alter table "changeset_comments" force row level security;

drop policy if exists "tenant_isolation" on "changeset_comments";
create policy "tenant_isolation" on "changeset_comments"
  using (organization_id = (current_setting('app.org_id', true))::uuid)
  with check (organization_id = (current_setting('app.org_id', true))::uuid);

grant select, insert, update, delete on "changeset_comments" to "mergecrew_app";
