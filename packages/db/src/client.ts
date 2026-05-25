import { Prisma, PrismaClient } from '@prisma/client';
import { makePgAdapter } from './adapter.js';

export type Tx = Prisma.TransactionClient;

let _prisma: PrismaClient | null = null;
let _systemPrisma: PrismaClient | null = null;

/**
 * Returns the singleton PrismaClient for tenant-scoped queries. Use
 * `withTenant()` for any tenant query so RLS sees a populated
 * `app.org_id`. Connects via `DATABASE_URL` (the no-bypass `mergecrew_app`
 * role in the canonical setup).
 */
export function getPrisma(): PrismaClient {
  if (_prisma) return _prisma;
  _prisma = new PrismaClient({
    adapter: makePgAdapter(),
    log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
  });
  return _prisma;
}

/**
 * Run a callback inside a transaction with `app.org_id` set so RLS isolates
 * the tenant. Throws if `organizationId` is empty.
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
 * Connects via `DATABASE_SYSTEM_URL` if set, otherwise `DATABASE_MIGRATE_URL`,
 * otherwise falls back to `DATABASE_URL`. The canonical setup points
 * those at the `mergecrew_migrator` role (`BYPASSRLS` per
 * `infra/sql/init/00-roles.sql`); the fallback to the app role only
 * works when that role is a superuser (e.g. local dev with
 * `POSTGRES_USER=mergecrew`).
 */
export function getSystemPrisma(): PrismaClient {
  if (_systemPrisma) return _systemPrisma;
  const systemUrl = process.env.DATABASE_SYSTEM_URL ?? process.env.DATABASE_MIGRATE_URL;
  _systemPrisma = systemUrl
    ? new PrismaClient({
        adapter: makePgAdapter({ url: systemUrl }),
        log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
      })
    : getPrisma();
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
