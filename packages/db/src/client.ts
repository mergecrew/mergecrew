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

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * Where the privileged (RLS-bypassing) system client connects.
 *
 *   - `system`           — `DATABASE_SYSTEM_URL`, the canonical setup:
 *                          the `mergecrew_system` role (BYPASSRLS, DML
 *                          only, owns nothing). Required in production.
 *   - `migrate-fallback` — dev/test only: `DATABASE_MIGRATE_URL` (the
 *                          migrator / table owner). Logged as a warning.
 *   - `app-fallback`     — dev/test only: reuse the `DATABASE_URL`
 *                          client. Only bypasses RLS when that role is a
 *                          superuser (e.g. dev compose's `mergecrew`).
 */
export type SystemDatabaseUrl =
  | { source: 'system'; url: string }
  | { source: 'migrate-fallback'; url: string }
  | { source: 'app-fallback' };

/**
 * Pure resolver behind `getSystemPrisma()` (exported for tests).
 *
 * Fails closed when `NODE_ENV=production`: runtime services must never
 * run cross-tenant queries as the migrator, which owns every table and
 * can alter schema and policies. There is deliberately no fallback in
 * production — an unset `DATABASE_SYSTEM_URL` is a deployment error.
 * Empty strings count as unset (compose passes `VAR=` through as "").
 */
export function resolveSystemDatabaseUrl(
  env: NodeJS.ProcessEnv = process.env,
): SystemDatabaseUrl {
  const systemUrl = nonEmpty(env.DATABASE_SYSTEM_URL);
  const migrateUrl = nonEmpty(env.DATABASE_MIGRATE_URL);
  const production = env.NODE_ENV === 'production';

  if (systemUrl) {
    if (production && migrateUrl && systemUrl === migrateUrl) {
      throw new Error(
        'getSystemPrisma: DATABASE_SYSTEM_URL must not equal DATABASE_MIGRATE_URL in production; ' +
          'point it at the mergecrew_system role (see infra/sql/README.md)',
      );
    }
    return { source: 'system', url: systemUrl };
  }
  if (production) {
    throw new Error(
      'getSystemPrisma: DATABASE_SYSTEM_URL is required in production (the mergecrew_system role, ' +
        'see infra/sql/README.md). Refusing to fall back to DATABASE_MIGRATE_URL or DATABASE_URL.',
    );
  }
  if (migrateUrl) return { source: 'migrate-fallback', url: migrateUrl };
  return { source: 'app-fallback' };
}

/**
 * Returns a privileged PrismaClient for cross-tenant system queries —
 * org creation, the auth middleware's org-by-slug lookup, listing all
 * orgs a user belongs to, etc.
 *
 * Connects via `DATABASE_SYSTEM_URL`: the `mergecrew_system` role
 * (`BYPASSRLS`, DML only, owns no tables; see `infra/sql/`). In
 * production the variable is mandatory and this throws without it.
 * Outside production it falls back to `DATABASE_MIGRATE_URL` (with a
 * warning) and then to the `DATABASE_URL` client, so local dev keeps
 * working against the superuser compose setup.
 *
 * Prefer `withTenant()` whenever the organization is known: RLS is the
 * hard isolation floor and this client skips it entirely.
 */
export function getSystemPrisma(): PrismaClient {
  if (_systemPrisma) return _systemPrisma;
  const resolved = resolveSystemDatabaseUrl();
  if (resolved.source === 'app-fallback') {
    _systemPrisma = getPrisma();
    return _systemPrisma;
  }
  if (resolved.source === 'migrate-fallback') {
    console.warn(
      '[db] DATABASE_SYSTEM_URL is unset; system queries are using DATABASE_MIGRATE_URL. ' +
        'This fallback is disabled when NODE_ENV=production.',
    );
  }
  const adapter = new PrismaPg(resolved.url);
  _systemPrisma = new PrismaClient({
    adapter,
    log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
  });
  return _systemPrisma;
}

/**
 * Run a callback bypassing RLS — for cross-tenant system jobs only.
 * Uses the privileged client returned by `getSystemPrisma()`, which
 * connects as the `mergecrew_system` role (`BYPASSRLS`, DML only) in
 * the canonical setup.
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
