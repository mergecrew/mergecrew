import type { PrismaService } from '../src/common/prisma.service';
import type { TenantContext, TenantContextService } from '../src/common/tenant-context.service';

export const ORG_A = '11111111-1111-4111-8111-111111111111';
export const ORG_B = '22222222-2222-4222-8222-222222222222';
export const USER_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
export const USER_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

export function fakeTenant(overrides: Partial<TenantContext> = {}): TenantContextService {
  const t: TenantContext = {
    organizationId: ORG_A,
    organizationSlug: 'org-a',
    userId: USER_A,
    role: 'admin',
    ...overrides,
  };
  return {
    require: () => t,
    current: () => t,
    user: () => ({ userId: t.userId, tenant: t }),
    requireUser: () => ({ userId: t.userId, tenant: t }),
  } as unknown as TenantContextService;
}

/** A PrismaService whose withTenant/withSystem hand `tx` to the callback. */
export function fakePrisma(tx: Record<string, unknown>): PrismaService {
  return {
    withTenant: async (_org: string, fn: (t: unknown) => unknown) => fn(tx),
    withSystem: async (fn: (t: unknown) => unknown) => fn(tx),
  } as unknown as PrismaService;
}

/**
 * Minimal in-memory matcher for Prisma `where` objects used by the fakes:
 * every scalar key must equal the row's value; nested objects (relation
 * filters such as `project: { slug }`) recurse into `row[key]`.
 */
export function matches(row: Record<string, any>, where: Record<string, any>): boolean {
  return Object.entries(where).every(([k, v]) => {
    if (v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date)) {
      if ('in' in v) return (v.in as unknown[]).includes(row[k]);
      if ('notIn' in v) return !(v.notIn as unknown[]).includes(row[k]);
      return row[k] != null && matches(row[k], v);
    }
    return row[k] === v;
  });
}
