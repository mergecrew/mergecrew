import { Injectable } from '@nestjs/common';
import { NotFoundError } from '@mergecrew/domain';
import { PrismaService } from '../../common/prisma.service.js';
import { TenantContextService } from '../../common/tenant-context.service.js';

@Injectable()
export class OrgService {
  constructor(private prisma: PrismaService, private tenant: TenantContextService) {}

  async listForUser(userId: string) {
    const ms = await this.prisma.withSystem((tx) =>
      tx.membership.findMany({
        where: { userId },
        include: { organization: true },
      }),
    );
    return ms
      .filter((m) => m.organization.deletedAt === null)
      .map((m) => ({
        id: m.organization.id,
        slug: m.organization.slug,
        name: m.organization.name,
        role: m.role,
      }));
  }

  async create(userId: string, name: string, slug: string) {
    const slugged = slug.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
    const existing = await this.prisma.withSystem((tx) =>
      tx.organization.findUnique({ where: { slug: slugged } }),
    );
    if (existing) throw new NotFoundError(`slug taken: ${slugged}`);
    const org = await this.prisma.withSystem((tx) =>
      tx.organization.create({ data: { name, slug: slugged } }),
    );
    await this.prisma.withSystem((tx) =>
      tx.membership.create({ data: { organizationId: org.id, userId, role: 'owner' } }),
    );
    return { id: org.id, slug: org.slug, name: org.name, role: 'owner' as const };
  }

  async detail() {
    const t = this.tenant.require();
    const org = await this.prisma.withTenant(t.organizationId, (tx) =>
      tx.organization.findUnique({ where: { id: t.organizationId } }),
    );
    if (!org) throw new NotFoundError();
    return org;
  }

  async listMembers() {
    const t = this.tenant.require();
    const rows = await this.prisma.withTenant(t.organizationId, (tx) =>
      tx.membership.findMany({
        where: { organizationId: t.organizationId },
        include: { user: true },
      }),
    );
    return rows.map((r) => ({
      id: r.id,
      role: r.role,
      user: { id: r.user.id, email: r.user.email, name: r.user.name },
    }));
  }

  async listAuditLog(opts: { limit?: number }) {
    const t = this.tenant.require();
    return this.prisma.withTenant(t.organizationId, (tx) =>
      tx.auditLogEntry.findMany({
        where: { organizationId: t.organizationId },
        orderBy: { occurredAt: 'desc' },
        take: opts.limit ?? 100,
      }),
    );
  }
}
