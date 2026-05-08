-- Bootstrap roles for local dev. Production is provisioned via Terraform/IaC.

-- Application role: NO BYPASSRLS, used by api/runner/orchestrator at runtime.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'mergecrew_app') then
    create role mergecrew_app login password 'mergecrew_app';
  end if;
end $$;

-- Migration role: BYPASSRLS, used by Prisma migrate.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'mergecrew_migrator') then
    create role mergecrew_migrator login password 'mergecrew_migrator' bypassrls;
  end if;
end $$;

grant connect on database mergecrew to mergecrew_app, mergecrew_migrator;
grant usage on schema public to mergecrew_app, mergecrew_migrator;
grant all privileges on schema public to mergecrew_migrator;

create extension if not exists "uuid-ossp";
create extension if not exists "pgcrypto";
create extension if not exists "vector";
