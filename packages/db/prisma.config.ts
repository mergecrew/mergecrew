import 'dotenv/config';
import { defineConfig } from 'prisma/config';

/**
 * Prisma 7 moved connection config from schema.prisma into this file. Two
 * URLs are at play in the canonical mergecrew setup:
 *
 *   - DATABASE_MIGRATE_URL → `mergecrew_migrator` (BYPASSRLS). The Prisma
 *     CLI (`prisma migrate`, `prisma generate`, `prisma studio`) uses this
 *     via the `datasource.url` below — migrations must be able to create
 *     tables and policies, which the no-bypass app role cannot do.
 *
 *   - DATABASE_URL → `mergecrew_app` (no BYPASSRLS). The runtime
 *     PrismaClient does *not* read this file; it builds its own adapter
 *     from `DATABASE_URL` via `makePgAdapter()` in `src/adapter.ts`.
 *
 * In v6 the same split was expressed as `datasource.directUrl` (migrator)
 * vs `datasource.url` (runtime). v7 removes `directUrl`; the runtime side
 * is now an explicit adapter constructed in code instead.
 *
 * Fallback chain mirrors the runtime: prefer the migrator URL, else the
 * runtime URL (the latter only works in dev where the role is a
 * superuser).
 */
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    seed: 'tsx src/seed.ts',
  },
  datasource: {
    url: process.env.DATABASE_MIGRATE_URL ?? process.env.DATABASE_URL ?? '',
  },
});
