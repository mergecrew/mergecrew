-- Mergecrew RLS migration. Idempotent so it can be re-run.

-- 1. pgvector + memory embeddings.
create extension if not exists vector;

alter table if exists memory_documents
  add column if not exists embedding vector(1536);

create index if not exists memory_documents_embedding_idx
  on memory_documents using ivfflat (embedding vector_cosine_ops) with (lists = 100);

-- 2. Enable RLS on every tenant-scoped table.
do $$
declare
  t text;
begin
  for t in
    select unnest(array[
      'organizations',
      'memberships',
      'audit_log_entries',
      'projects',
      'connected_repos',
      'deploy_targets',
      'project_secrets',
      'llm_providers',
      'llm_profiles',
      'lifecycles',
      'gate_policies',
      'daily_runs',
      'workflow_runs',
      'agent_steps',
      'tool_calls',
      'model_turns',
      'llm_invocations',
      'run_pauses',
      'changesets',
      'deploys',
      'decisions',
      'approval_requests',
      'intent_inbox_items',
      'schedules',
      'timeline_events',
      'memory_documents'
    ])
  loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
  end loop;
end $$;

-- 3. Drop existing tenant-isolation policies (if any) before recreating.
do $$
declare
  t text;
begin
  for t in
    select unnest(array[
      'organizations','memberships','audit_log_entries','projects','connected_repos',
      'deploy_targets','project_secrets','llm_providers','llm_profiles','lifecycles',
      'gate_policies','daily_runs','workflow_runs','agent_steps','tool_calls',
      'model_turns','llm_invocations','run_pauses','changesets','deploys','decisions',
      'approval_requests','intent_inbox_items','schedules','timeline_events','memory_documents'
    ])
  loop
    execute format('drop policy if exists tenant_isolation on %I', t);
  end loop;
end $$;

-- 4. Create tenant-isolation policies.
create policy tenant_isolation on organizations
  for all
  using (id = current_setting('app.org_id', true)::uuid)
  with check (id = current_setting('app.org_id', true)::uuid);

do $$
declare
  t text;
begin
  for t in
    select unnest(array[
      'memberships','audit_log_entries','projects','connected_repos',
      'deploy_targets','project_secrets','llm_providers','llm_profiles','lifecycles',
      'gate_policies','daily_runs','workflow_runs','agent_steps','tool_calls',
      'model_turns','llm_invocations','run_pauses','changesets','deploys','decisions',
      'approval_requests','intent_inbox_items','schedules','timeline_events','memory_documents'
    ])
  loop
    execute format($f$
      create policy tenant_isolation on %I
        for all
        using (organization_id = current_setting('app.org_id', true)::uuid)
        with check (organization_id = current_setting('app.org_id', true)::uuid)
    $f$, t);
  end loop;
end $$;

-- 5. Grant the application role what it needs.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'mergecrew_app') then
    grant select, insert, update, delete on all tables in schema public to mergecrew_app;
    grant usage, select on all sequences in schema public to mergecrew_app;
    alter default privileges in schema public
      grant select, insert, update, delete on tables to mergecrew_app;
    alter default privileges in schema public
      grant usage, select on sequences to mergecrew_app;
  end if;
end $$;

-- 6. Helper used by the application to set tenant context.
create or replace function set_app_org(org uuid) returns void
language plpgsql as $$
begin
  perform set_config('app.org_id', org::text, true);
end $$;
