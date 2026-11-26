import { Injectable, Logger } from '@nestjs/common';
import { NotFoundError, ValidationError } from '@mergecrew/domain';
import { EmailClient, emailConfigFromEnv } from '@mergecrew/adapters-comms';
import { PrismaService } from '../../common/prisma.service.js';
import { TenantContextService } from '../../common/tenant-context.service.js';

export type InviteRole = 'admin' | 'operator' | 'viewer';

/** How long an invitation stays acceptable. */
export const INVITATION_TTL_MS = 14 * 24 * 60 * 60 * 1000;

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function webBase(): string {
  return (process.env.WEB_BASE_URL ?? 'http://localhost:3000').replace(/\/+$/, '');
}

/**
 * Org invitations.
 *
 * Admin side (`invite`, `listForOrg`, `revoke`) runs in the caller's tenant.
 * The response to `invite` is identical whether or not the address has a
 * Mergecrew account, and no membership is created until the invitee — signed
 * in with that exact email — accepts (`listMine`, `accept`, `decline`).
 */
@Injectable()
export class InvitationService {
  private readonly logger = new Logger(InvitationService.name);
  private email?: EmailClient;

  constructor(
    private prisma: PrismaService,
    private tenant: TenantContextService,
  ) {}

  async invite(rawEmail: string, role: InviteRole) {
    const t = this.tenant.require();
    const email = String(rawEmail ?? '').trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || email.length > 254) {
      throw new ValidationError('a valid email is required');
    }
    const expiresAt = new Date(Date.now() + INVITATION_TTL_MS);
    const inv = await this.prisma.withTenant(t.organizationId, (tx) =>
      tx.orgInvitation.upsert({
        where: { organizationId_email: { organizationId: t.organizationId, email } },
        create: { organizationId: t.organizationId, email, role, invitedByUserId: t.userId, expiresAt },
        update: { role, invitedByUserId: t.userId, expiresAt },
      }),
    );
    await this.prisma.withTenant(t.organizationId, (tx) =>
      tx.auditLogEntry.create({
        data: {
          organizationId: t.organizationId,
          actorUserId: t.userId,
          action: 'org.member.invited',
          target: { invitationId: inv.id },
          metadata: { role },
        },
      }),
    );
    void this.sendInviteEmail(email, t.organizationSlug).catch((err) => {
      this.logger.warn(`invitation email failed: ${String((err as Error)?.message ?? err)}`);
    });
    return {
      ok: true as const,
      invitation: { id: inv.id, email: inv.email, role: inv.role, status: 'pending' as const, expiresAt: inv.expiresAt },
    };
  }

  async listForOrg() {
    const t = this.tenant.require();
    const rows = await this.prisma.withTenant(t.organizationId, (tx) =>
      tx.orgInvitation.findMany({
        where: { organizationId: t.organizationId, expiresAt: { gt: new Date() } },
        orderBy: { createdAt: 'desc' },
        select: { id: true, email: true, role: true, createdAt: true, expiresAt: true },
      }),
    );
    return { items: rows };
  }

  async revoke(id: string) {
    const t = this.tenant.require();
    const res = await this.prisma.withTenant(t.organizationId, (tx) =>
      tx.orgInvitation.deleteMany({ where: { id, organizationId: t.organizationId } }),
    );
    if (res.count === 0) throw new NotFoundError('invitation not found');
    return { ok: true };
  }

  /** Pending, unexpired invitations addressed to the signed-in user's email. */
  async listMine() {
    const email = await this.currentUserEmail();
    const rows = await this.prisma.withSystem((tx) =>
      tx.orgInvitation.findMany({
        where: { email, expiresAt: { gt: new Date() }, organization: { deletedAt: null } },
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          role: true,
          createdAt: true,
          expiresAt: true,
          organization: { select: { slug: true, name: true } },
        },
      }),
    );
    return { items: rows };
  }

  async accept(id: string) {
    const { userId, email } = await this.currentUser();
    const inv = await this.prisma.withSystem((tx) =>
      tx.orgInvitation.findFirst({
        where: { id, email, expiresAt: { gt: new Date() }, organization: { deletedAt: null } },
        include: { organization: { select: { id: true, slug: true, name: true } } },
      }),
    );
    if (!inv) throw new NotFoundError('invitation not found');
    await this.prisma.withTenant(inv.organizationId, async (tx) => {
      const existing = await tx.membership.findFirst({
        where: { organizationId: inv.organizationId, userId },
        select: { id: true },
      });
      if (!existing) {
        await tx.membership.create({
          data: { organizationId: inv.organizationId, userId, role: inv.role },
        });
      }
      await tx.orgInvitation.deleteMany({ where: { id: inv.id, organizationId: inv.organizationId } });
      await tx.auditLogEntry.create({
        data: {
          organizationId: inv.organizationId,
          actorUserId: userId,
          action: 'org.member.invitation_accepted',
          target: { invitationId: inv.id, userId },
          metadata: { role: inv.role },
        },
      });
    });
    return { ok: true, organization: { slug: inv.organization.slug, name: inv.organization.name } };
  }

  async decline(id: string) {
    const email = await this.currentUserEmail();
    const inv = await this.prisma.withSystem((tx) =>
      tx.orgInvitation.findFirst({ where: { id, email }, select: { id: true, organizationId: true } }),
    );
    if (!inv) throw new NotFoundError('invitation not found');
    await this.prisma.withTenant(inv.organizationId, (tx) =>
      tx.orgInvitation.deleteMany({ where: { id: inv.id, organizationId: inv.organizationId } }),
    );
    return { ok: true };
  }

  private async currentUser(): Promise<{ userId: string; email: string }> {
    const userId = this.tenant.requireUser().userId;
    const u = await this.prisma.withSystem((tx) =>
      tx.user.findUnique({ where: { id: userId }, select: { email: true } }),
    );
    if (!u) throw new NotFoundError('user not found');
    return { userId, email: u.email.trim().toLowerCase() };
  }

  private async currentUserEmail(): Promise<string> {
    return (await this.currentUser()).email;
  }

  private async sendInviteEmail(email: string, orgSlug: string): Promise<void> {
    this.email ??= new EmailClient(emailConfigFromEnv());
    const link = escapeHtml(`${webBase()}/account/invitations`);
    const org = escapeHtml(orgSlug);
    await this.email.send(
      [email],
      'You have been invited to a Mergecrew organization',
      `<!doctype html>
<html><body style="font-family:system-ui,sans-serif;max-width:520px;margin:32px auto;color:#111">
  <h2 style="margin-bottom:8px">You're invited to ${org}</h2>
  <p>An admin of the <b>${org}</b> organization invited you to join it on Mergecrew.
  Sign in with this email address to review and accept the invitation.</p>
  <p style="margin:24px 0">
    <a href="${link}" style="background:#111;color:#fff;padding:10px 16px;border-radius:6px;text-decoration:none;display:inline-block">Review invitation</a>
  </p>
  <p style="font-size:12px;color:#666">If you weren't expecting this, ignore this email — nothing happens unless you accept.</p>
</body></html>`,
    );
  }
}
