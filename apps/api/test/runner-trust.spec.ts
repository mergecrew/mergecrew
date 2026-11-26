jest.mock('@mergecrew/db', () => ({
  seedDemoProject: jest.fn(),
  withTenant: jest.fn(),
  withSystem: jest.fn(),
  getPrisma: jest.fn(),
}));

import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { AdminController } from '../src/modules/admin/admin.controller';
import type { AdminService } from '../src/modules/admin/admin.service';
import { isTrustedOrgId } from '../src/common/trusted-orgs';
import { OrgService } from '../src/modules/org/org.service';
import { RunnerProfileService } from '../src/modules/org/runner-profile.service';
import type { CryptoService } from '../src/common/crypto.service';
import type { TelemetryService } from '../src/common/telemetry.service';
import { ORG_A, ORG_B, USER_A, fakePrisma, fakeTenant } from './helpers';

const ENV_KEYS = [
  'MERGECREW_TRUSTED_ORG_IDS',
  'MERGECREW_OWNER_ORG_ID',
  'MERGECREW_TRUSTED_ORG_SLUGS',
  'MERGECREW_OWNER_ORG_SLUG',
  'MERGECREW_SEED_DEMO_PROJECT',
];
const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  process.env.MERGECREW_SEED_DEMO_PROJECT = '0';
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('built-in runner trust keyed on org id', () => {
  it('matches only configured org UUIDs, never slugs', () => {
    process.env.MERGECREW_TRUSTED_ORG_SLUGS = 'acme';
    process.env.MERGECREW_OWNER_ORG_SLUG = 'acme';
    expect(isTrustedOrgId(ORG_A)).toBe(false);
    process.env.MERGECREW_TRUSTED_ORG_IDS = `${ORG_B}, ${ORG_A.toUpperCase()}`;
    expect(isTrustedOrgId(ORG_A)).toBe(true);
    expect(isTrustedOrgId('acme')).toBe(false);
  });

  it('creating an org with a (formerly) trusted slug grants nothing', async () => {
    process.env.MERGECREW_OWNER_ORG_SLUG = 'acme';
    process.env.MERGECREW_TRUSTED_ORG_SLUGS = 'acme';
    const tx = {
      organization: {
        findUnique: jest.fn(async () => null),
        create: jest.fn(async ({ data }: any) => ({ id: ORG_B, ...data })),
      },
      membership: { create: jest.fn(async () => ({})) },
      runnerProfile: { create: jest.fn(async () => ({})) },
    };
    const svc = new OrgService(fakePrisma(tx), fakeTenant(), { emit: jest.fn() } as unknown as TelemetryService);
    await svc.create(USER_A, 'Acme', 'acme');
    expect(tx.runnerProfile.create.mock.calls[0]![0].data).toEqual({ organizationId: ORG_B, kind: 'none' });
  });

  it('renaming into a trusted slug does not unlock instance_builtin', async () => {
    process.env.MERGECREW_OWNER_ORG_SLUG = 'acme';
    const svc = new RunnerProfileService(
      fakePrisma({}),
      fakeTenant({ organizationId: ORG_A, organizationSlug: 'acme', role: 'admin' }),
      {} as CryptoService,
    );
    await expect(svc.update({ kind: 'instance_builtin' })).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('instance health is only served to operator orgs by id, not by slug', async () => {
    process.env.MERGECREW_OWNER_ORG_SLUG = 'acme';
    const admin = { health: jest.fn(async () => ({ ok: true })) } as unknown as AdminService;
    const bySlug = new AdminController(admin, fakeTenant({ organizationId: ORG_B, organizationSlug: 'acme' }));
    await expect(bySlug.health()).rejects.toBeInstanceOf(NotFoundException);
    process.env.MERGECREW_OWNER_ORG_ID = ORG_A;
    const byId = new AdminController(admin, fakeTenant({ organizationId: ORG_A, organizationSlug: 'other' }));
    await expect(byId.health()).resolves.toEqual({ ok: true });
  });

  it('org UUID in the allowlist may select instance_builtin', async () => {
    process.env.MERGECREW_OWNER_ORG_ID = ORG_A;
    const tx = {
      runnerProfile: {
        findUnique: jest.fn(async () => ({ kind: 'none', awsExternalId: null, githubTokenCiphertext: null })),
        upsert: jest.fn(async ({ update }: any) => ({ organizationId: ORG_A, ...update })),
      },
      auditLogEntry: { create: jest.fn(async () => ({})) },
    };
    const svc = new RunnerProfileService(
      fakePrisma(tx),
      fakeTenant({ organizationId: ORG_A, organizationSlug: 'whatever', role: 'admin' }),
      {} as CryptoService,
    );
    await expect(svc.update({ kind: 'instance_builtin' })).resolves.toBeDefined();
  });
});
