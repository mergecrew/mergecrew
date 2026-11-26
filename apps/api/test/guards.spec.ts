jest.mock('@mergecrew/db', () => ({ withTenant: jest.fn(), withSystem: jest.fn(), getPrisma: jest.fn() }));

import { ForbiddenException } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RoleGuard } from '../src/common/role.guard';
import { DemoProjectGuard } from '../src/common/demo-project.guard';
import type { TenantContextService } from '../src/common/tenant-context.service';
import { ORG_A, USER_A, fakePrisma, matches } from './helpers';

const RUN_DEMO = '55555555-5555-4555-8555-555555555555';
const tenant = { organizationId: ORG_A, organizationSlug: 'org-a', userId: USER_A, role: 'admin' as const };

function ctx(req: Record<string, unknown>): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => req }),
    getHandler: () => () => {},
    getClass: () => class {},
  } as unknown as ExecutionContext;
}

describe('RoleGuard', () => {
  const guard = (t: unknown) =>
    new RoleGuard(new Reflector(), { current: () => t } as unknown as TenantContextService);

  it('denies org-scoped routes without tenant context even with no required role', () => {
    expect(() => guard(undefined).canActivate(ctx({ params: { slug: 'org-a' } }))).toThrow(ForbiddenException);
  });

  it('allows org-scoped routes with a tenant', () => {
    expect(guard(tenant).canActivate(ctx({ params: { slug: 'org-a' } }))).toBe(true);
  });
});

describe('DemoProjectGuard', () => {
  const prev = process.env.MERGECREW_DEMO_MODE;
  beforeAll(() => {
    delete process.env.MERGECREW_DEMO_MODE;
  });
  afterAll(() => {
    if (prev === undefined) delete process.env.MERGECREW_DEMO_MODE;
    else process.env.MERGECREW_DEMO_MODE = prev;
  });

  const demoProject = { demo: true };
  const regular = { demo: false };
  const tx = {
    project: {
      findFirst: jest.fn(async ({ where }: any) =>
        [
          { organizationId: ORG_A, slug: 'web', deletedAt: null, ...regular },
          { organizationId: ORG_A, slug: 'demo-saas', deletedAt: null, ...demoProject },
        ].find((r) => matches(r, where)) ?? null,
      ),
    },
    changeset: {
      findFirst: jest.fn(async ({ where }: any) =>
        matches({ id: 'cs-demo', organizationId: ORG_A }, where) ? { project: demoProject } : null,
      ),
    },
    approvalRequest: { findFirst: jest.fn(async () => null) },
    dailyRun: {
      findFirst: jest.fn(async ({ where }: any) =>
        matches({ id: RUN_DEMO, organizationId: ORG_A }, where) ? { project: demoProject } : null,
      ),
    },
  };
  const guard = new DemoProjectGuard(fakePrisma(tx));
  const req = (method: string, params: Record<string, string>, withTenant = true) => ({
    method,
    params,
    ...(withTenant ? { mergecrewUser: { userId: USER_A, tenant } } : {}),
  });

  it('denies any :slug route that arrives without a tenant', async () => {
    await expect(guard.canActivate(ctx(req('GET', { slug: 'org-a' }, false)))).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('blocks mutating a demo-project changeset through a non-demo slug', async () => {
    await expect(
      guard.canActivate(ctx(req('POST', { slug: 'org-a', projectSlug: 'web', csId: 'cs-demo' }))),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('blocks cancelling a demo-project run through a non-demo slug', async () => {
    await expect(
      guard.canActivate(ctx(req('POST', { slug: 'org-a', projectSlug: 'web', runId: RUN_DEMO }))),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('still blocks the URL demo project and allows regular projects', async () => {
    await expect(
      guard.canActivate(ctx(req('POST', { slug: 'org-a', projectSlug: 'demo-saas' }))),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(guard.canActivate(ctx(req('POST', { slug: 'org-a', projectSlug: 'web' })))).resolves.toBe(true);
  });

  it('allows safe methods on demo objects', async () => {
    await expect(
      guard.canActivate(ctx(req('GET', { slug: 'org-a', projectSlug: 'web', csId: 'cs-demo' }))),
    ).resolves.toBe(true);
  });
});
