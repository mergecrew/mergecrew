-- Bootstrap roles for local dev + CI (mounted into the Postgres
-- container's /docker-entrypoint-initdb.d and run by CI's bootstrap
-- step). Passwords here are dev-only. Host-installed production
-- Postgres uses infra/sql/native-bootstrap.sql instead.

-- Application role: NO BYPASSRLS, used by api/runner/orchestrator/
-- worker-cron at runtime for tenant-scoped queries (DATABASE_URL).
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'mergecrew_app') then
    create role mergecrew_app login password 'mergecrew_app';
  end if;
end $$;

-- System role: BYPASSRLS, DML only, owns nothing. Used by
-- getSystemPrisma()/withSystem() for explicitly cross-tenant queries
-- (DATABASE_SYSTEM_URL). Table grants come from default privileges
-- below + migration 20261126210000_eval_rls_and_system_role.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'mergecrew_system') then
    create role mergecrew_system login password 'mergecrew_system' bypassrls;
  end if;
end $$;

-- Migration role: BYPASSRLS, owns the schema objects, used only by
-- Prisma migrate (DATABASE_MIGRATE_URL). CREATEDB is a dev-only
-- convenience so `prisma migrate dev` can create its shadow database.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'mergecrew_migrator') then
    create role mergecrew_migrator login password 'mergecrew_migrator' bypassrls createdb;
  end if;
end $$;

grant connect on database mergecrew to mergecrew_app, mergecrew_system, mergecrew_migrator;
grant usage on schema public to mergecrew_app, mergecrew_system, mergecrew_migrator;
grant all privileges on schema public to mergecrew_migrator;

-- Tables/sequences the migrator creates are usable by the runtime
-- roles without a per-migration GRANT.
alter default privileges for role mergecrew_migrator in schema public
  grant select, insert, update, delete on tables to mergecrew_app, mergecrew_system;
alter default privileges for role mergecrew_migrator in schema public
  grant usage, select on sequences to mergecrew_app, mergecrew_system;

create extension if not exists "uuid-ossp";
create extension if not exists "pgcrypto";
create extension if not exists "vector";
