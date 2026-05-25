import { PrismaPg } from '@prisma/adapter-pg';

/**
 * Builds a Prisma 7 node-postgres adapter from a connection string.
 * Centralises the env routing so the swap at every `new PrismaClient(...)`
 * site is mechanical:
 *
 *   new PrismaClient({ adapter: makePgAdapter() })            // runtime / DATABASE_URL
 *   new PrismaClient({ adapter: makePgAdapter({ url: ... }) }) // explicit role URL
 *
 * The default URL is `DATABASE_URL` — the no-bypass `mergecrew_app` role
 * in the canonical setup, which is what runtime tenant queries must use
 * so RLS sees a populated `app.org_id`. Callers that need a privileged
 * connection (e.g. `getSystemPrisma`, the RLS test's migrator client)
 * pass an explicit `opts.url`.
 *
 * Throws if neither `opts.url` nor `DATABASE_URL` is set — failing loud
 * here beats Prisma surfacing a less-specific connection error deep in a
 * query.
 */
export function makePgAdapter(opts?: { url?: string }): PrismaPg {
  const connectionString = opts?.url ?? process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error(
      'makePgAdapter: neither opts.url nor DATABASE_URL is set; cannot build a Prisma node-postgres adapter',
    );
  }
  return new PrismaPg({ connectionString });
}
