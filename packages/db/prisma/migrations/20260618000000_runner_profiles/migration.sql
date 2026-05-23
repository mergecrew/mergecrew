-- Per-org runner ownership (V2.af / ADR-0002). Two new tables:
--   runner_profiles  — 1:1 with organizations; selects execution substrate.
--   runner_agents    — bearer-token-authenticated agents enrolled by an org.
-- Both RLS-on, modeled on audit_log_entries.
--
-- Backfill: every pre-existing organization gets a runner_profiles row
-- with kind='instance_builtin'. This preserves today's behavior (one
-- driver picked by RUNNER_SANDBOX, applied to every org) until
-- per-run dispatch lands in #763. Newly created orgs after this
-- migration default to kind='none' (ADR-0008).

create type "runner_profile_kind" as enum (
  'none',
  'instance_builtin',
  'agent',
  'fargate_byo',
  'github_actions'
);

create table "runner_profiles" (
  "id"                         uuid                primary key default gen_random_uuid(),
  "organization_id"            uuid                not null unique,
  "kind"                       runner_profile_kind not null    default 'none',
  "aws_role_arn"               text,
  "aws_external_id"            text,
  "aws_region"                 text,
  "fargate_cluster"            text,
  "fargate_task_definition"    text,
  "fargate_subnets"            text[]              not null    default '{}',
  "fargate_security_groups"    text[]              not null    default '{}',
  "github_repo_full_name"      text,
  "github_workflow_file_name"  text,
  "github_token_ciphertext"    bytea,
  "created_at"                 timestamptz(6)      not null    default now(),
  "updated_at"                 timestamptz(6)      not null    default now(),
  constraint "runner_profiles_org_fk"
    foreign key ("organization_id") references "organizations" ("id") on delete cascade
);

alter table "runner_profiles" enable row level security;
alter table "runner_profiles" force row level security;

create policy "tenant_isolation" on "runner_profiles"
  using (organization_id = (current_setting('app.org_id', true))::uuid)
  with check (organization_id = (current_setting('app.org_id', true))::uuid);

create table "runner_agents" (
  "id"                  uuid           primary key default gen_random_uuid(),
  "organization_id"     uuid           not null,
  "name"                text           not null,
  "token_hash"          text           not null unique,
  "prefix"              text           not null,
  "created_by_user_id"  uuid,
  "created_at"          timestamptz(6) not null default now(),
  "last_seen_at"        timestamptz(6),
  "revoked_at"          timestamptz(6),
  "agent_version"       text,
  constraint "runner_agents_org_fk"
    foreign key ("organization_id") references "organizations" ("id") on delete cascade
);

create index "runner_agents_org_revoked_idx"
  on "runner_agents" ("organization_id", "revoked_at");

alter table "runner_agents" enable row level security;
alter table "runner_agents" force row level security;

create policy "tenant_isolation" on "runner_agents"
  using (organization_id = (current_setting('app.org_id', true))::uuid)
  with check (organization_id = (current_setting('app.org_id', true))::uuid);

-- Backfill: existing orgs keep today's behavior (instance_builtin =
-- "use whatever RUNNER_SANDBOX is configured for"). New orgs created
-- after this migration default to 'none'.
insert into "runner_profiles" ("organization_id", "kind")
select "id", 'instance_builtin'::runner_profile_kind
from "organizations"
on conflict ("organization_id") do nothing;
