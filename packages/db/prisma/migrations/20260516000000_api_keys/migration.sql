-- API keys for programmatic access (#138).
-- Plaintext tokens are returned once; the DB only ever stores sha256(token).

create table if not exists "api_keys" (
  "id"                  uuid not null,
  "organization_id"     uuid not null,
  "name"                text not null,
  "token_hash"          text not null,
  "prefix"              text not null,
  "role"                "org_role" not null default 'operator',
  "created_by_user_id"  uuid,
  "created_at"          timestamp(6) with time zone not null default current_timestamp,
  "last_used_at"        timestamp(6) with time zone,
  "revoked_at"          timestamp(6) with time zone,
  constraint "api_keys_pkey" primary key ("id")
);

create unique index if not exists "api_keys_token_hash_key" on "api_keys" ("token_hash");
create index if not exists "api_keys_organization_id_idx" on "api_keys" ("organization_id");

alter table "api_keys"
  add constraint "api_keys_organization_id_fkey"
  foreign key ("organization_id") references "organizations" ("id") on delete cascade on update cascade;

alter table "api_keys" enable row level security;
alter table "api_keys" force row level security;

drop policy if exists "tenant_isolation" on "api_keys";
create policy "tenant_isolation" on "api_keys"
  using (organization_id = (current_setting('app.org_id', true))::uuid)
  with check (organization_id = (current_setting('app.org_id', true))::uuid);

grant select, insert, update, delete on "api_keys" to "mergecrew_app";
