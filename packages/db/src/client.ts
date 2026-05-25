import { Prisma, PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

export type Tx = Prisma.TransactionClient;

let _prisma: PrismaClient | null = null;
let _systemPrisma: PrismaClient | null = null;

/**
 * Returns the singleton PrismaClient for tenant-scoped queries. Use
 * `withTenant()` for any tenant query so RLS sees a populated
 * `app.org_id`. Connects via `DATABASE_URL` (the no-bypass
 * `mergecrew_app` role in the canonical setup).
 *
 * Prisma 7 (#794): the connection URL no longer lives in
 * `schema.prisma`. We construct a `PrismaPg` adapter from
 * `DATABASE_URL` and hand it to the client at construction time.
 * The adapter routes queries through `node-postgres` directly
 * instead of the bundled query engine binary.
 */
export function getPrisma(): PrismaClient {
  if (_prisma) return _prisma;
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error('getPrisma: DATABASE_URL is required for the runtime PrismaClient');
  }
  const adapter = new PrismaPg(url);
  _prisma = new PrismaClient({
    adapter,
    log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
  });
  return _prisma;
}

/**
 * Run a callback inside a transaction with `app.org_id` set so RLS
 * isolates the tenant. Throws if `organizationId` is empty.
 */
export async function withTenant<T>(
  organizationId: string,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  if (!organizationId) {
    throw new Error('withTenant: organizationId is required');
  }
  const prisma = getPrisma();
  return prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`select set_config('app.org_id', $1, true)`, organizationId);
    return fn(tx);
  });
}

/**
 * Returns a privileged PrismaClient for cross-tenant system queries —
 * org creation, the auth middleware's org-by-slug lookup, listing all
 * orgs a user belongs to, etc.
 *
 * Connects via `DATABASE_SYSTEM_URL` if set, otherwise
 * `DATABASE_MIGRATE_URL`, otherwise falls back to `DATABASE_URL`. The
 * canonical setup points those at the `mergecrew_migrator` role
 * (`BYPASSRLS` per `infra/sql/init/00-roles.sql`); the fallback to
 * the app role only works when that role is a superuser (e.g. local
 * dev with `POSTGRES_USER=mergecrew`).
 */
export function getSystemPrisma(): PrismaClient {
  if (_systemPrisma) return _systemPrisma;
  const systemUrl = process.env.DATABASE_SYSTEM_URL ?? process.env.DATABASE_MIGRATE_URL;
  if (!systemUrl) {
    _systemPrisma = getPrisma();
    return _systemPrisma;
  }
  const adapter = new PrismaPg(systemUrl);
  _systemPrisma = new PrismaClient({
    adapter,
    log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
  });
  return _systemPrisma;
}

/**
 * Run a callback bypassing RLS — for cross-tenant system jobs only.
 * Uses the privileged client returned by `getSystemPrisma()`, which
 * connects with a `BYPASSRLS` role in the canonical setup.
 */
export async function withSystem<T>(fn: (tx: PrismaClient) => Promise<T>): Promise<T> {
  return fn(getSystemPrisma());
}

/**
 * Build a standalone PrismaClient bound to a specific connection
 * URL. Used by test code that wants its own client (no singleton)
 * scoped to e.g. the migrator role for RLS verification — the
 * canonical setup has `mergecrew_app` and `mergecrew_migrator` as
 * two distinct roles, and tests need to instantiate both.
 *
 * Prefer `getPrisma()` for production code; `buildClientForUrl` is a
 * convenience to wrap the adapter construction so callers don't
 * import `@prisma/adapter-pg` directly.
 */
export function buildClientForUrl(url: string): PrismaClient {
  return new PrismaClient({
    adapter: new PrismaPg(url),
  });
}
