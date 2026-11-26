import { defineConfig } from 'prisma/config';

/**
 * Connection URL for the Prisma migration CLI (exported for tests).
 *
 * Migrations run as the migrator role (`mergecrew_migrator`: owns the
 * schema objects, has CREATE on `public`), so prefer
 * `DATABASE_MIGRATE_URL`. `DATABASE_URL` is only a fallback for setups
 * that use one superuser URL for everything (CI, the dev compose
 * stack). Before #895 this read `DATABASE_URL` alone, so on hosts with
 * least-privilege roles `migrate deploy` ran as the runtime app role
 * and failed with `permission denied for schema public`.
 *
 * Empty strings count as unset: compose passes `VAR=` lines through as
 * "" rather than omitting them.
 */
export function resolveMigrationUrl(env: NodeJS.ProcessEnv = process.env): string {
  const migrate = env.DATABASE_MIGRATE_URL?.trim();
  if (migrate) return migrate;
  return env.DATABASE_URL?.trim() ?? '';
}

/**
 * Prisma 7 config (#794). Replaces the `datasource.url` /
 * `datasource.directUrl` lines that used to live in
 * `prisma/schema.prisma`.
 *
 *   `datasource.url` — required by `prisma migrate deploy/dev/reset`
 *                      and `prisma db pull`. The schema-side
 *                      `datasource db` block intentionally has no
 *                      `url` field (Prisma 7's adapter-aware client
 *                      doesn't need it), but the migration CLI still
 *                      does. See `resolveMigrationUrl` above. It stays
 *                      '' when nothing is set so `prisma generate`
 *                      (which needs no database) works in image builds.
 *   The runtime clients construct their own adapters from
 *   `DATABASE_URL` / `DATABASE_SYSTEM_URL` in `src/client.ts`; nothing
 *   here for the runtime path.
 */
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    url: resolveMigrationUrl(),
  },
  experimental: {
    adapter: true,
  },
});
