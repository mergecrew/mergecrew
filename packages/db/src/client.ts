import { Prisma, PrismaClient } from '@prisma/client';

export type Tx = Prisma.TransactionClient;

let _prisma: PrismaClient | null = null;

/**
 * Returns the singleton PrismaClient. Use `withTenant()` for any tenant-scoped
 * query so that RLS sees a populated `app.org_id`.
 */
export function getPrisma(): PrismaClient {
  if (_prisma) return _prisma;
  _prisma = new PrismaClient({
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
 * Run a callback bypassing RLS — for cross-tenant system jobs only.
 * The runtime asserts the caller is the migrator role; otherwise
 * the underlying connection still has RLS enforced and rows will
 * be invisible.
 */
export async function withSystem<T>(fn: (tx: PrismaClient) => Promise<T>): Promise<T> {
  const prisma = getPrisma();
  return fn(prisma);
}
