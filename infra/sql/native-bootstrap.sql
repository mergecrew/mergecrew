-- Mergecrew bootstrap for a host-installed PostgreSQL (single-VM deploy,
-- docs/03-infrastructure/19-vm-deploy.md). Run as a superuser, e.g.:
--
--   sudo -u postgres psql -f infra/sql/native-bootstrap.sql
--   sudo -u postgres psql -v db_name=mergecrew -f infra/sql/native-bootstrap.sql
--
-- Idempotent: safe to re-run on an existing deployment (it is also the
-- upgrade path that adds `mergecrew_system`). It never drops data and
-- never changes an existing password unless you pass one.
--
-- Roles it manages (all LOGIN, none SUPERUSER/CREATEDB/CREATEROLE):
--
--   mergecrew_migrator  BYPASSRLS. Owns the database and every table.
--                       Only the compose `migrate` service uses it
--                       (DATABASE_MIGRATE_URL).
--   mergecrew_app       NO BYPASSRLS. Runtime tenant-scoped queries
--                       (DATABASE_URL); RLS enforces isolation.
--   mergecrew_system    BYPASSRLS, DML only (select/insert/update/delete
--                       on tables, usage/select on sequences), owns
--                       nothing, so it cannot ALTER/DROP tables or
--                       policies. Runtime cross-tenant queries
--                       (DATABASE_SYSTEM_URL).
--
-- Passwords: roles are created without one. Set them interactively so
-- the plaintext never lands in shell history or the server log:
--
--   sudo -u postgres psql -c '\password mergecrew_system'
--
-- or pass them as psql variables (-v system_password=...) /
-- environment variables (MERGECREW_SYSTEM_DB_PASSWORD, ...; psql 15+).
-- Note: with `log_statement = 'ddl'` or `'all'` the server logs ALTER
-- ROLE ... PASSWORD statements in plaintext; prefer \password then.
--
-- pg_hba.conf: containers reach the host through the docker bridge, so
-- their source address is inside 172.16.0.0/12 (docker's default
-- address pool). Allow only the three roles, only to this database,
-- only with scram-sha-256, and make sure `listen_addresses` includes
-- the bridge gateway (e.g. 'localhost,172.17.0.1'):
--
--   # TYPE  DATABASE   USER                                               ADDRESS        METHOD
--   host    mergecrew  mergecrew_app,mergecrew_system,mergecrew_migrator  172.16.0.0/12  scram-sha-256
--
-- Narrow the ADDRESS to the compose network's subnet if you know it
-- (`docker network inspect mergecrew_internal`). Reload with
-- `sudo systemctl reload postgresql` after editing.

\set ON_ERROR_STOP on

\if :{?db_name}
\else
  \set db_name mergecrew
\endif

\if :{?migrator_password}
\else
  \getenv migrator_password MERGECREW_MIGRATOR_DB_PASSWORD
\endif
\if :{?app_password}
\else
  \getenv app_password MERGECREW_APP_DB_PASSWORD
\endif
\if :{?system_password}
\else
  \getenv system_password MERGECREW_SYSTEM_DB_PASSWORD
\endif

-- 1. Roles ---------------------------------------------------------------

select 'create role mergecrew_migrator'
  where not exists (select 1 from pg_roles where rolname = 'mergecrew_migrator') \gexec
select 'create role mergecrew_app'
  where not exists (select 1 from pg_roles where rolname = 'mergecrew_app') \gexec
select 'create role mergecrew_system'
  where not exists (select 1 from pg_roles where rolname = 'mergecrew_system') \gexec

-- Re-assert attributes every run so drift (e.g. a role granted
-- CREATEROLE by hand) is corrected.
alter role mergecrew_migrator with login nosuperuser nocreatedb nocreaterole noreplication bypassrls;
alter role mergecrew_app      with login nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
alter role mergecrew_system   with login nosuperuser nocreatedb nocreaterole noreplication bypassrls;

\if :{?migrator_password}
select format('alter role mergecrew_migrator password %L', :'migrator_password') \gexec
\endif
\if :{?app_password}
select format('alter role mergecrew_app password %L', :'app_password') \gexec
\endif
\if :{?system_password}
select format('alter role mergecrew_system password %L', :'system_password') \gexec
\endif

-- 2. Database --------------------------------------------------------------

select format('create database %I owner mergecrew_migrator', :'db_name')
  where not exists (select 1 from pg_database where datname = :'db_name') \gexec

-- Only the Mergecrew roles may connect. On a VM shared with other
-- projects this keeps their database roles out of this database.
revoke all on database :"db_name" from public;
grant connect, temporary on database :"db_name"
  to mergecrew_migrator, mergecrew_app, mergecrew_system;

\connect :"db_name"

-- 3. Schema + extensions -----------------------------------------------------

revoke create on schema public from public;
grant usage, create on schema public to mergecrew_migrator;
grant usage on schema public to mergecrew_app, mergecrew_system;

create extension if not exists "uuid-ossp";
create extension if not exists "pgcrypto";
create extension if not exists "vector";

-- 4. Table privileges ----------------------------------------------------------

-- Existing tables (no-op on an empty database).
grant select, insert, update, delete on all tables in schema public
  to mergecrew_app, mergecrew_system;
grant usage, select on all sequences in schema public
  to mergecrew_app, mergecrew_system;

-- Tables the migrator creates from now on.
alter default privileges for role mergecrew_migrator in schema public
  grant select, insert, update, delete on tables to mergecrew_app, mergecrew_system;
alter default privileges for role mergecrew_migrator in schema public
  grant usage, select on sequences to mergecrew_app, mergecrew_system;

do $$
begin
  if to_regclass('public._prisma_migrations') is not null then
    revoke all on table public._prisma_migrations from mergecrew_system;
  end if;
end $$;

-- 5. Verification ----------------------------------------------------------------

\echo
\echo 'Roles (expect: no superuser; bypassrls only for migrator + system):'
select rolname, rolcanlogin as login, rolsuper as superuser, rolbypassrls as bypassrls,
       rolcreatedb as createdb, rolcreaterole as createrole,
       rolpassword is not null as has_password
  from pg_authid
 where rolname in ('mergecrew_migrator', 'mergecrew_app', 'mergecrew_system')
 order by rolname;

\echo 'Table owners in public (expect: mergecrew_migrator only):'
select tableowner, count(*) as tables
  from pg_tables
 where schemaname = 'public'
 group by tableowner
 order by tableowner;

\echo 'Tenant tables without enabled+forced RLS (expect: none after migrations):'
select c.relname as table_name
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  join pg_attribute a on a.attrelid = c.oid and a.attname = 'organization_id' and not a.attisdropped
 where n.nspname = 'public'
   and c.relkind = 'r'
   and not (c.relrowsecurity and c.relforcerowsecurity)
 order by c.relname;
