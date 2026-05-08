# Data model

Concrete schemas. PostgreSQL with Prisma. RLS policies are defined in `infra/sql/policies.sql` and applied as part of migrations.

## Conventions

- All tables use `uuid` primary keys (v7 for time-ordering).
- Tenant tables carry `organization_id uuid not null`.
- Timestamps in UTC: `created_at`, `updated_at` (trigger-maintained), and where appropriate `started_at`, `finished_at`, `occurred_at`.
- Soft delete via `deleted_at` is used only for `Project` and `Organization`.
- Enums are Postgres native enums for low-churn enums; lookup tables for high-churn enums.
- JSONB used for unstructured payloads (event payloads, tool call inputs/outputs).

## Schema

### Identity & tenancy

```sql
create table users (
  id uuid primary key,
  email text not null unique,
  name text,
  avatar_url text,
  default_org_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table organizations (
  id uuid primary key,
  slug text not null unique,
  name text not null,
  timezone text not null default 'UTC',
  working_hours_start time not null default '09:00',
  working_hours_end time not null default '18:00',
  default_llm_profile_id uuid,
  default_gate_policy_id uuid,
  compliance_audit_retention_days int not null default 365,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create type org_role as enum ('owner','admin','operator','viewer');

create table memberships (
  id uuid primary key,
  organization_id uuid not null references organizations(id),
  user_id uuid not null references users(id),
  role org_role not null,
  created_at timestamptz not null default now(),
  unique (organization_id, user_id)
);

create table audit_log_entries (
  id uuid primary key,
  organization_id uuid not null,
  actor_user_id uuid,                      -- null for system actions
  action text not null,                    -- e.g., 'org.role_changed'
  target jsonb not null,                   -- structured target ref
  metadata jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null default now()
);
```

### Projects

```sql
create table projects (
  id uuid primary key,
  organization_id uuid not null,
  slug text not null,
  name text not null,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  unique (organization_id, slug)
);

create table connected_repos (
  id uuid primary key,
  organization_id uuid not null,
  project_id uuid not null references projects(id) unique,
  vcs_provider text not null,              -- 'github'
  installation_id text not null,
  repo_id text not null,
  repo_full_name text not null,            -- 'owner/name'
  default_branch text not null,
  created_at timestamptz not null default now()
);

create type deploy_target_kind as enum ('dev','staging','prod');

create table deploy_targets (
  id uuid primary key,
  organization_id uuid not null,
  project_id uuid not null references projects(id),
  kind deploy_target_kind not null,
  adapter_id text not null,                -- 'github-actions' | 'vercel' | …
  config jsonb not null,                   -- adapter-specific
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (project_id, kind)
);

create table project_secrets (
  id uuid primary key,
  organization_id uuid not null,
  project_id uuid not null references projects(id),
  name text not null,
  ciphertext bytea not null,               -- envelope-encrypted
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (project_id, name)
);
```

### LLM profiles & providers

```sql
create table llm_providers (
  id uuid primary key,
  organization_id uuid not null,
  kind text not null,                      -- 'anthropic' | 'openai' | 'bedrock' | 'ollama'
  label text not null,
  endpoint text,                           -- ollama url, optional
  credential_ciphertext bytea,             -- nullable for adapters that use IAM
  capability_overrides jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table llm_profiles (
  id uuid primary key,
  organization_id uuid not null,
  name text not null,
  preference_order jsonb not null,         -- ['anthropic-org-1/claude-opus-4-7', …]
  capability_routing jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, name)
);

create table model_price_table (
  provider_kind text not null,
  model_id text not null,
  effective_at timestamptz not null,
  input_per_million_usd numeric(10,6) not null,
  output_per_million_usd numeric(10,6) not null,
  cache_read_per_million_usd numeric(10,6),
  cache_write_per_million_usd numeric(10,6),
  primary key (provider_kind, model_id, effective_at)
);
```

### Lifecycle & versions

```sql
create table lifecycles (
  id uuid primary key,
  organization_id uuid not null,
  project_id uuid not null references projects(id),
  version int not null,
  source_yaml text not null,               -- the mergecrew.yaml at this version
  parsed jsonb not null,                   -- normalized graph
  active_from timestamptz not null default now(),
  unique (project_id, version)
);

create table gate_policies (
  id uuid primary key,
  organization_id uuid not null,
  project_id uuid,                         -- null = org default
  policy jsonb not null,
  version int not null,
  active_from timestamptz not null default now()
);
```

### Runs

```sql
create type daily_run_status as enum ('pending','running','paused_rate_limit','paused_gate','done','failed','cancelled');

create table daily_runs (
  id uuid primary key,
  organization_id uuid not null,
  project_id uuid not null references projects(id),
  lifecycle_id uuid not null references lifecycles(id),
  scheduled_at timestamptz not null,
  started_at timestamptz,
  finished_at timestamptz,
  status daily_run_status not null default 'pending',
  metadata jsonb not null default '{}'::jsonb
);

create table workflow_runs (
  id uuid primary key,
  organization_id uuid not null,
  daily_run_id uuid not null references daily_runs(id),
  workflow_id text not null,               -- 'pm', 'implementation', …
  parent_workflow_run_id uuid,             -- for child workflows (per-changeset)
  status text not null,                    -- 'pending','running','done','failed','gated'
  started_at timestamptz,
  finished_at timestamptz
);

create table agent_steps (
  id uuid primary key,
  organization_id uuid not null,
  workflow_run_id uuid not null references workflow_runs(id),
  agent_kind text not null,
  agent_instance_id uuid not null,         -- the configured Agent
  attempt int not null default 1,
  status text not null,                    -- 'pending','running','done','failed','rate_limited','cancelled'
  input jsonb not null,
  output jsonb,
  failure_reason text,
  started_at timestamptz,
  finished_at timestamptz,
  total_input_tokens int not null default 0,
  total_output_tokens int not null default 0,
  total_usd_estimate numeric(12,6) not null default 0
);

create table tool_calls (
  id uuid primary key,
  organization_id uuid not null,
  agent_step_id uuid not null references agent_steps(id),
  sequence int not null,
  skill_name text not null,
  input jsonb not null,
  output jsonb,
  is_error bool not null default false,
  started_at timestamptz not null,
  finished_at timestamptz,
  side_effect_class text not null
);

create table model_turns (
  id uuid primary key,
  organization_id uuid not null,
  agent_step_id uuid not null references agent_steps(id),
  sequence int not null,
  provider_id uuid not null references llm_providers(id),
  model_id text not null,
  input_tokens int not null,
  output_tokens int not null,
  cache_read_tokens int not null default 0,
  cache_write_tokens int not null default 0,
  thinking_tokens int,
  latency_ms int not null,
  usd_estimate numeric(12,6) not null,
  raw_request_blob_url text,               -- s3 url of raw request, for replay
  raw_response_blob_url text,
  occurred_at timestamptz not null default now()
);

create table run_pauses (
  id uuid primary key,
  organization_id uuid not null,
  daily_run_id uuid not null references daily_runs(id),
  step_id uuid references agent_steps(id),
  kind text not null,                      -- 'rate_limit' | 'gate'
  provider_id uuid,                        -- for rate_limit
  approval_request_id uuid,                -- for gate
  paused_at timestamptz not null,
  wake_at timestamptz,
  resumed_at timestamptz
);
```

### Changesets

```sql
create type changeset_status as enum (
  'proposed','building','testing','tests_failed','flagged',
  'pr_open','dev_deployed','awaiting_decision',
  'promoted','rolled_back','deferred','abandoned'
);

create table changesets (
  id text primary key,                     -- 'cs_2tA9X' short id
  organization_id uuid not null,
  project_id uuid not null references projects(id),
  daily_run_id uuid not null references daily_runs(id),
  workflow_run_id uuid references workflow_runs(id),
  title text not null,
  why_paragraph text,
  branch text not null,
  status changeset_status not null default 'proposed',
  pr_number int,
  pr_url text,
  dev_deploy_id uuid,
  test_summary jsonb,                      -- { passed, failed, suites: [...] }
  risk_chip text,                          -- 'low'|'medium'|'high'
  estimated_usd numeric(12,6) not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table deploys (
  id uuid primary key,
  organization_id uuid not null,
  project_id uuid not null,
  changeset_id text references changesets(id),
  deploy_target_id uuid not null references deploy_targets(id),
  ref text not null,
  correlation_id text not null,
  external_run_id text,
  url text,
  status text not null,
  started_at timestamptz not null,
  finished_at timestamptz,
  unique (project_id, correlation_id)
);

create table decisions (
  id uuid primary key,
  organization_id uuid not null,
  changeset_id text not null references changesets(id),
  user_id uuid not null,
  kind text not null,                      -- 'promote'|'rollback'|'defer'
  comment text,
  occurred_at timestamptz not null default now()
);

create table approval_requests (
  id uuid primary key,
  organization_id uuid not null,
  project_id uuid not null,
  workflow_run_id uuid not null,
  changeset_id text,
  reason text not null,                    -- 'auth_path'|'migration'|'production_promote'|...
  details jsonb not null,
  required_role text not null,             -- 'operator'|'admin'|'owner'
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_by_user_id uuid,
  resolution text                          -- 'approve'|'reject'|'takeover'
);

create table intent_inbox_items (
  id uuid primary key,
  organization_id uuid not null,
  project_id uuid not null,
  submitted_by_user_id uuid not null,
  body text not null,
  status text not null default 'queued',   -- 'queued'|'picked_up'|'cancelled'
  picked_up_run_id uuid,
  created_at timestamptz not null default now()
);
```

### Timeline & memory

```sql
create table timeline_events (
  id bigserial primary key,
  event_id uuid not null unique,
  organization_id uuid not null,
  project_id uuid not null,
  daily_run_id uuid,
  workflow_run_id uuid,
  agent_step_id uuid,
  changeset_id text,
  parent_event_id uuid,
  type text not null,
  actor jsonb not null,                    -- { kind: 'agent' | 'user' | 'system', id }
  payload jsonb not null,
  occurred_at timestamptz not null
);

create index timeline_events_run_idx on timeline_events (daily_run_id, occurred_at desc);
create index timeline_events_project_idx on timeline_events (project_id, occurred_at desc);

create table memory_documents (
  id uuid primary key,
  organization_id uuid not null,
  project_id uuid not null,
  collection text not null,                -- 'project_facts' | 'past_decisions' | …
  content text not null,
  embedding vector(1536),                  -- pgvector
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index on memory_documents using ivfflat (embedding vector_cosine_ops) with (lists = 100);
```

## RLS

For every tenant table:

```sql
alter table <t> enable row level security;
create policy <t>_tenant_isolation on <t>
  for all
  using (organization_id = current_setting('app.org_id', true)::uuid)
  with check (organization_id = current_setting('app.org_id', true)::uuid);
```

The application role:

```sql
create role mergecrew_app login password '...';
grant connect on database mergecrew to mergecrew_app;
grant usage on schema public to mergecrew_app;
grant select, insert, update, delete on all tables in schema public to mergecrew_app;
alter role mergecrew_app set search_path = public;
-- BYPASSRLS not granted.
```

A separate role for migrations:

```sql
create role mergecrew_migrator login password '...';
grant all privileges on database mergecrew to mergecrew_migrator;
alter role mergecrew_migrator with bypassrls;
```

## Indexes & query patterns

- `daily_runs(project_id, scheduled_at desc)` — list runs for a project.
- `agent_steps(workflow_run_id)` and `agent_steps(status, started_at)` for the dispatch monitor.
- `changesets(project_id, status, updated_at desc)` — digest assembly.
- `tool_calls(agent_step_id, sequence)` — transcript replay.
- `model_turns(agent_step_id, sequence)` — same.
- `timeline_events(daily_run_id, occurred_at)` — timeline render.
- `audit_log_entries(organization_id, occurred_at desc)` — settings page.
- pgvector index on `memory_documents.embedding`.

## Object storage layout (intended pattern — not yet wired up)

The intended object-storage layout for transcripts, raw LLM payloads, screenshots, and diffs is below. No S3 writer code exists in the repo yet; this is the shape the upload paths and `raw_request_blob_url` / `raw_response_blob_url` columns are designed to point at.

```
s3://mergecrew-artifacts/
  orgs/<org_id>/
    runs/<run_id>/
      transcripts/<agent_step_id>.jsonl       # per step
      raw-llm/<model_turn_id>.req.json
      raw-llm/<model_turn_id>.resp.json
      screenshots/<changeset_id>-<ref>.png
      diffs/<changeset_id>.patch
```

Intended controls: blobs encrypted with KMS; lifecycle policy of transcripts 90 days, raw LLM 30 days, screenshots/diffs 180 days; configurable per org for compliance customers.
