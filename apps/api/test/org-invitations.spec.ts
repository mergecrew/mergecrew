import { InvitationService } from '../src/modules/invitation/invitation.service';
import { OrgService } from '../src/modules/org/org.service';
import { createFakeDb, fakeTenant } from './helpers/fake-prisma';

const ORG = 'org-1';
const adminCtx = {
  userId: 'admin-1',
  tenant: { organizationId: ORG, organizationSlug: 'acme', userId: 'admin-1', role: 'admin' },
};

function make(ctx: any = adminCtx) {
  const { db, prisma } = createFakeDb();
  db.organization.rows.push({ id: ORG, slug: 'acme', name: 'Acme', deletedAt: null });
  db.user.rows.push({ id: 'existing-1', email: 'existing@example.com', name: 'E' });
  const svc = new InvitationService(prisma, fakeTenant(ctx));
  (svc as any).email = { send: async () => {} };
  return { db, prisma, svc };
}

describe('InvitationService', () => {
  it('responds identically whether or not the address has an account, and adds nobody', async () => {
    const { svc, db } = make();
    const a = await svc.invite('existing@example.com', 'viewer');
    const b = await svc.invite('nobody@example.com', 'viewer');
    const shape = (r: any) => ({ ...r, invitation: { ...r.invitation, id: 'x', email: 'x', expiresAt: 'x' } });
    expect(shape(a)).toEqual(shape(b));
    expect(a.invitation.status).toBe('pending');
    expect(db.membership.rows).toHaveLength(0);
  });

  it('only the invited address can accept; acceptance creates the membership', async () => {
    const { svc, db, prisma } = make();
    const { invitation } = await svc.invite('Existing@Example.com', 'operator');

    const stranger = new InvitationService(prisma, fakeTenant({ userId: 'other' }));
    db.user.rows.push({ id: 'other', email: 'other@example.com' });
    await expect(stranger.accept(invitation.id)).rejects.toThrow(/not found/);

    const invitee = new InvitationService(prisma, fakeTenant({ userId: 'existing-1' }));
    await expect(invitee.listMine()).resolves.toMatchObject({ items: [{ id: invitation.id }] });
    await expect(invitee.accept(invitation.id)).resolves.toMatchObject({ ok: true });
    expect(db.membership.rows).toEqual([
      expect.objectContaining({ organizationId: ORG, userId: 'existing-1', role: 'operator' }),
    ]);
    expect(db.orgInvitation.rows).toHaveLength(0);
  });

  it('expired invitations cannot be accepted', async () => {
    const { svc, db, prisma } = make();
    const { invitation } = await svc.invite('existing@example.com', 'viewer');
    db.orgInvitation.rows[0].expiresAt = new Date(Date.now() - 1000);
    const invitee = new InvitationService(prisma, fakeTenant({ userId: 'existing-1' }));
    await expect(invitee.accept(invitation.id)).rejects.toThrow(/not found/);
  });
});

describe('OrgService.detail', () => {
  it('never selects the Slack webhook ciphertext', async () => {
    const { prisma } = make();
    let args: any;
    prisma.withTenant = async (_o: string, fn: any) =>
      fn({ organization: { findUnique: async (a: any) => ((args = a), { id: ORG }) } });
    const svc = new OrgService(prisma, fakeTenant(adminCtx), {} as any);
    await svc.detail();
    expect(args.select).toBeDefined();
    expect(args.select.slackWebhookCiphertext).toBeUndefined();
    expect(Object.keys(args.select).some((k) => /ciphertext/i.test(k))).toBe(false);
    expect(args.select.slackWebhookCreatedAt).toBe(true);
  });
});
