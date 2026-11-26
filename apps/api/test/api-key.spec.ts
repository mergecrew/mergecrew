jest.mock('@mergecrew/db', () => ({ withTenant: jest.fn(), withSystem: jest.fn(), getPrisma: jest.fn() }));

import { ForbiddenException } from '@nestjs/common';
import { ApiKeyService, apiKeyCreatorStillAuthorized } from '../src/modules/api-key/api-key.service';
import { ORG_A, USER_A, fakePrisma, fakeTenant } from './helpers';

function issuer(role: 'owner' | 'admin' | 'operator' | 'viewer') {
  const tx = {
    apiKey: {
      create: jest.fn(async ({ data }: any) => ({ id: 'k1', createdAt: new Date(), ...data })),
    },
    auditLogEntry: { create: jest.fn(async () => ({})) },
  };
  return { svc: new ApiKeyService(fakePrisma(tx), fakeTenant({ role })), tx };
}

describe('api key issuance', () => {
  it('admin cannot mint an owner key', async () => {
    const { svc, tx } = issuer('admin');
    await expect(svc.issue({ name: 'ci', role: 'owner' })).rejects.toBeInstanceOf(ForbiddenException);
    expect(tx.apiKey.create).not.toHaveBeenCalled();
  });

  it('operator cannot mint an admin key', async () => {
    const { svc } = issuer('operator');
    await expect(svc.issue({ name: 'ci', role: 'admin' })).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('owner can mint an owner key; creator is recorded', async () => {
    const { svc, tx } = issuer('owner');
    const k = await svc.issue({ name: 'ci', role: 'owner' });
    expect(k.role).toBe('owner');
    expect(tx.apiKey.create.mock.calls[0]![0].data.createdByUserId).toBe(USER_A);
  });

  it('admin can mint keys up to admin', async () => {
    const { svc } = issuer('admin');
    await expect(svc.issue({ name: 'ci', role: 'admin' })).resolves.toMatchObject({ role: 'admin' });
  });
});

describe('api key creator check', () => {
  const prismaWith = (membership: { role: string } | null) =>
    fakePrisma({ membership: { findFirst: jest.fn(async () => membership) } });

  it('rejects keys whose creator is no longer a member', async () => {
    await expect(
      apiKeyCreatorStillAuthorized(prismaWith(null), {
        organizationId: ORG_A,
        createdByUserId: USER_A,
        role: 'operator',
      }),
    ).resolves.toBe(false);
  });

  it('rejects keys whose creator was demoted below the key role', async () => {
    await expect(
      apiKeyCreatorStillAuthorized(prismaWith({ role: 'operator' }), {
        organizationId: ORG_A,
        createdByUserId: USER_A,
        role: 'admin',
      }),
    ).resolves.toBe(false);
  });

  it('rejects keys without a recorded creator', async () => {
    await expect(
      apiKeyCreatorStillAuthorized(prismaWith({ role: 'owner' }), {
        organizationId: ORG_A,
        createdByUserId: null,
        role: 'viewer',
      }),
    ).resolves.toBe(false);
  });

  it('accepts keys whose creator still holds at least the key role', async () => {
    const prisma = prismaWith({ role: 'admin' });
    await expect(
      apiKeyCreatorStillAuthorized(prisma, { organizationId: ORG_A, createdByUserId: USER_A, role: 'operator' }),
    ).resolves.toBe(true);
  });
});
