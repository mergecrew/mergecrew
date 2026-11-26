# SQL bootstrap & RLS

## Database roles

Mergecrew connects to Postgres with three roles. Each URL goes only to the
processes that need it.

| Role | Env var | Attributes | Used by |
|---|---|---|---|
| `mergecrew_app` | `DATABASE_URL` | LOGIN, **no** BYPASSRLS, DML only | api, orchestrator, runner, worker-cron: tenant-scoped queries via `withTenant()` |
| `mergecrew_system` | `DATABASE_SYSTEM_URL` | LOGIN, BYPASSRLS, DML only, **owns nothing** | the same services: explicitly cross-tenant queries via `withSystem()` / `getSystemPrisma()` |
| `mergecrew_migrator` | `DATABASE_MIGRATE_URL` | LOGIN, BYPASSRLS, owns the database and every table, CREATE on `public` | `prisma migrate deploy` only (the compose `migrate` service, `pnpm db:migrate`) |

The system role can read and write across tenants but cannot `ALTER`/`DROP`
tables, disable RLS, or change policies, because it owns none of them. In
production (`NODE_ENV=production`) `getSystemPrisma()` refuses to start
without `DATABASE_SYSTEM_URL`; it never falls back to the migrator.
`packages/db/prisma.config.ts` runs migrations with `DATABASE_MIGRATE_URL`,
falling back to `DATABASE_URL` only when no migrator URL is set (CI, single-URL
dev setups).

Table privileges for the runtime roles come from
`ALTER DEFAULT PRIVILEGES FOR ROLE mergecrew_migrator`, so every table a later
migration creates is covered automatically. Migrations
`20260508000001_rls` (app) and `20261126210000_eval_rls_and_system_role`
(system) also grant on the tables that already exist, when the role exists.

## Files

- `init/00-roles.sql` is mounted into the local Postgres container by
  `docker-compose.yml` / `docker-compose.full.yml` and run by CI. It runs once
  on first start and creates the three roles with **dev-only** passwords, the
  default privileges and the required extensions (`uuid-ossp`, `pgcrypto`,
  `vector`).
- `native-bootstrap.sql` is for a host-installed PostgreSQL (the single-VM
  deploy in `docs/03-infrastructure/19-vm-deploy.md`). Run it as a superuser:

  ```sh
  sudo -u postgres psql -f infra/sql/native-bootstrap.sql
  sudo -u postgres psql -c '\password mergecrew_system'   # and the other two on first install
  ```

  It is idempotent and is also the upgrade path for an existing deployment. It
  creates any missing role, re-asserts role attributes, creates the database
  (owned by the migrator), revokes `CONNECT` from `PUBLIC` so other projects'
  roles on a shared host cannot connect, grants schema usage, installs the
  extensions, grants DML on existing tables and sequences, sets the default
  privileges, and prints a verification report (role attributes, table
  owners, tenant tables without RLS). It never drops data or changes a
  password you didn't pass. The header of the file has the `pg_hba.conf`
  lines for containers on the docker bridge (`172.16.0.0/12`,
  `scram-sha-256`, these three roles, this database only).

## RLS

After Prisma's initial migration, `packages/db/prisma/migrations/20260508000001_rls/migration.sql`:

1. Adds the pgvector embedding column to `memory_documents`.
2. Enables + forces RLS on every tenant-scoped table.
3. Creates the `tenant_isolation` policy on each
   (`organization_id = current_setting('app.org_id', true)::uuid`).
4. Grants the application role what it needs (no BYPASSRLS).
5. Defines the `set_app_org(uuid)` helper used by the application.

Later migrations that add tenant tables enable + force RLS and create the same
policy in the same migration (for example `20260617000000_alert_routes`,
`20260618000000_runner_profiles`, `20261126210000_eval_rls_and_system_role`).
`packages/db/test/rls.test.ts` checks cross-tenant isolation with the app role
and the limits of the system role.

In production these migrations run as part of the deploy (`scripts/deploy.sh`
/ `scripts/deploy-pull.sh` run the compose `migrate` service).
