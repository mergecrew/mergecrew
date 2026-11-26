jest.mock('@mergecrew/db', () => ({
  seedDemoProject: jest.fn(),
  withTenant: jest.fn(),
  withSystem: jest.fn(),
  getPrisma: jest.fn(),
}));

import { ForbiddenError } from '@mergecrew/domain';
import { OrgService } from '../src/modules/org/org.service';
import type { TelemetryService } from '../src/common/telemetry.service';
import { ORG_A, USER_A, USER_B, fakePrisma, fakeTenant, matches } from './helpers';

type Role = 'owner' | 'admin' | 'operator' | 'viewer';

function setup(callerRole: Role, memberships: Array<{ id: string; userId: string; role: Role }>) {
  const rows = memberships.map((m) => ({ ...m, organizationId: ORG_A }));
  const tx = {
    membership: {
      findFirst: jest.fn(async ({ where }: any) => rows.find((r) => matches(r, where)) ?? null),
      count: jest.fn(async ({ where }: any) => rows.filter((r) => matches(r, where)).length),
      update: jest.fn(async ({ where, data }: any) => {
        const r = rows.find((x) => matches(x, where));
        if (!r) throw new Error('P2025');
        Object.assign(r, data);
        return r;
      }),
      delete: jest.fn(async () => ({})),
    },
    apiKey: { updateMany: jest.fn(async () => ({ count: 1 })) },
  };
  const svc = new OrgService(
    fakePrisma(tx),
    fakeTenant({ role: callerRole, userId: USER_A }),
    { emit: jest.fn() } as unknown as TelemetryService,
  );
  return { svc, tx };
}

describe('membership owner protection', () => {
  it('admin cannot promote themselves to owner', async () => {
    const { svc, tx } = setup('admin', [
      { id: 'm-self', userId: USER_A, role: 'admin' },
      { id: 'm-owner', userId: USER_B, role: 'owner' },
    ]);
    await expect(svc.updateMemberRole('m-self', 'owner')).rejects.toBeInstanceOf(ForbiddenError);
    expect(tx.membership.update).not.toHaveBeenCalled();
  });

  it('admin cannot demote an owner', async () => {
    const { svc, tx } = setup('admin', [
      { id: 'm-self', userId: USER_A, role: 'admin' },
      { id: 'm-owner', userId: USER_B, role: 'owner' },
    ]);
    await expect(svc.updateMemberRole('m-owner', 'viewer')).rejects.toBeInstanceOf(ForbiddenError);
    expect(tx.membership.update).not.toHaveBeenCalled();
  });

  it('admin cannot remove an owner', async () => {
    const { svc, tx } = setup('admin', [
      { id: 'm-o1', userId: USER_B, role: 'owner' },
      { id: 'm-o2', userId: 'u3', role: 'owner' },
    ]);
    await expect(svc.removeMember('m-o1')).rejects.toBeInstanceOf(ForbiddenError);
    expect(tx.membership.delete).not.toHaveBeenCalled();
  });

  it('owner can grant owner', async () => {
    const { svc, tx } = setup('owner', [
      { id: 'm-self', userId: USER_A, role: 'owner' },
      { id: 'm-b', userId: USER_B, role: 'admin' },
    ]);
    await expect(svc.updateMemberRole('m-b', 'owner')).resolves.toEqual({ id: 'm-b', role: 'owner' });
    expect(tx.membership.update.mock.calls[0]![0].where).toEqual({ id: 'm-b', organizationId: ORG_A });
  });

  it('admin can still manage non-owner members', async () => {
    const { svc } = setup('admin', [{ id: 'm-b', userId: USER_B, role: 'operator' }]);
    await expect(svc.updateMemberRole('m-b', 'viewer')).resolves.toEqual({ id: 'm-b', role: 'viewer' });
  });

  it('removing a member revokes the api keys they created', async () => {
    const { svc, tx } = setup('admin', [{ id: 'm-b', userId: USER_B, role: 'operator' }]);
    await svc.removeMember('m-b');
    expect(tx.membership.delete.mock.calls[0]![0].where).toEqual({ id: 'm-b', organizationId: ORG_A });
    const revoke = (tx.apiKey.updateMany.mock.calls as any[])[0]![0];
    expect(revoke.where).toEqual({ organizationId: ORG_A, createdByUserId: USER_B, revokedAt: null });
    expect(revoke.data.revokedAt).toBeInstanceOf(Date);
  });

  it('demoting a member revokes their keys above the new role', async () => {
    const { svc, tx } = setup('owner', [{ id: 'm-b', userId: USER_B, role: 'admin' }]);
    await svc.updateMemberRole('m-b', 'operator');
    const revoke = (tx.apiKey.updateMany.mock.calls as any[])[0]![0];
    expect(revoke.where.createdByUserId).toBe(USER_B);
    expect(revoke.where.role.in.sort()).toEqual(['admin', 'owner']);
  });
});
