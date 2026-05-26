import { defineConfig } from 'prisma/config';

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
 *                      does. We pull it from DATABASE_URL — CI sets
 *                      it and the local `.env` does too.
 *   The runtime client constructs its own adapter from `DATABASE_URL`
 *   in `src/client.ts`; nothing here for the runtime path.
 */
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    url: process.env.DATABASE_URL ?? '',
  },
  experimental: {
    adapter: true,
  },
});
