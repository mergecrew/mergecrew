-- Eval tables under RLS + table grants for the `mergecrew_system` role.
--
-- 1. `eval_runs` and `eval_ab_runs` carry a NOT NULL `organization_id`
--    but were created without RLS (20260601000000_eval_harness,
--    20260602000000_eval_ab_runs). Every runtime read/write already
--    goes through `withTenant()` (eval-runner, api eval.service,
--    orchestrator digest-anomalies), so the standard tenant policy is a
--    pure tightening. `eval_cases` has no `organization_id`; it is
--    scoped through its parent run, and because the subquery on
--    `eval_runs` is itself RLS-filtered it only matches the active
--    tenant's runs.
--
-- 2. `mergecrew_system` is the BYPASSRLS, DML-only role behind
--    `getSystemPrisma()` / `DATABASE_SYSTEM_URL`. Roles are cluster
--    level, so the role itself is created out of band
--    (`infra/sql/init/00-roles.sql` for dev/CI,
--    `infra/sql/native-bootstrap.sql` for host-installed Postgres). This
--    migration only grants table/sequence DML when the role exists, and
--    sets default privileges so tables created by later migrations
--    (which run as the migrator) are covered too. No-op when the role
--    is absent, same DO-block pattern as 20260508000001_rls.
--
-- Idempotent: safe to re-run.

alter table "eval_runs" enable row level security;
alter table "eval_runs" force row level security;
drop policy if exists "tenant_isolation" on "eval_runs";
create policy "tenant_isolation" on "eval_runs"
  using (organization_id = (current_setting('app.org_id', true))::uuid)
  with check (organization_id = (current_setting('app.org_id', true))::uuid);

alter table "eval_ab_runs" enable row level security;
alter table "eval_ab_runs" force row level security;
drop policy if exists "tenant_isolation" on "eval_ab_runs";
create policy "tenant_isolation" on "eval_ab_runs"
  using (organization_id = (current_setting('app.org_id', true))::uuid)
  with check (organization_id = (current_setting('app.org_id', true))::uuid);

alter table "eval_cases" enable row level security;
alter table "eval_cases" force row level security;
drop policy if exists "tenant_isolation" on "eval_cases";
create policy "tenant_isolation" on "eval_cases"
  using (exists (select 1 from "eval_runs" r where r.id = "eval_cases".eval_run_id))
  with check (exists (select 1 from "eval_runs" r where r.id = "eval_cases".eval_run_id));

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'mergecrew_system') then
    grant select, insert, update, delete on all tables in schema public to mergecrew_system;
    grant usage, select on all sequences in schema public to mergecrew_system;
    alter default privileges in schema public
      grant select, insert, update, delete on tables to mergecrew_system;
    alter default privileges in schema public
      grant usage, select on sequences to mergecrew_system;
    -- Migration bookkeeping is the migrator's business only.
    if to_regclass('public._prisma_migrations') is not null then
      revoke all on table public._prisma_migrations from mergecrew_system;
    end if;
  end if;
end $$;
