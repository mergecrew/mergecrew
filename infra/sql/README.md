# SQL bootstrap & RLS

`init/` is mounted into the local Postgres container by `docker-compose.yml`
and runs once on first start to:

1. Create the `mergecrew_app` and `mergecrew_migrator` roles.
2. Install required extensions (`uuid-ossp`, `pgcrypto`, `vector`).

After Prisma's initial migration runs, `packages/db/prisma/migrations/20260508000000_init_rls/migration.sql` is applied; it:

1. Adds the pgvector embedding column to `memory_documents`.
2. Enables RLS on every tenant-scoped table.
3. Creates the `tenant_isolation` policy on each.
4. Grants the application role what it needs (no BYPASSRLS).
5. Defines the `set_app_org(uuid)` helper used by the application.

In production these scripts run automatically as part of `pnpm db:migrate`
during the deploy pipeline.
