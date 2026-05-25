import { defineConfig } from 'prisma/config';

/**
 * Prisma 7 config (#794). Replaces the `datasource.url` /
 * `datasource.directUrl` lines that used to live in
 * `prisma/schema.prisma`.
 *
 *   `migrate.url`     — used by `prisma migrate dev / deploy` and
 *                       `prisma generate`. Points at the migrator
 *                       role (BYPASSRLS via `infra/sql/init/00-roles.sql`),
 *                       same envvar the schema used to read directly.
 *   The runtime client constructs its own adapter from `DATABASE_URL`
 *   in `src/client.ts`; nothing here for the runtime path.
 */
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  experimental: {
    adapter: true,
  },
});
