import { Injectable } from '@nestjs/common';
import { NotFoundError, ValidationError } from '@mergecrew/domain';
import { PrismaService } from '../../common/prisma.service.js';
import { TenantContextService } from '../../common/tenant-context.service.js';

function startOfUtcDay(d: Date): Date {
  const r = new Date(d);
  r.setUTCHours(0, 0, 0, 0);
  return r;
}

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

  /**
   * Sum of `usd_estimate` for the current org's LLM invocations since
   * UTC midnight today. Used to enforce `dailyBudgetUsd`.
   */
  async todaysSpendUsd(): Promise<number> {
    const t = this.tenant.require();
    const since = startOfUtcDay(new Date());
    const rows = await this.prisma.withTenant(t.organizationId, (tx) =>
      tx.llmInvocation.aggregate({
        where: { organizationId: t.organizationId, occurredAt: { gte: since } },
        _sum: { usdEstimate: true },
      }),
    );
    return Number(rows._sum.usdEstimate ?? 0);
  }

  async updateBudget(dailyBudgetUsd: number | null) {
    const t = this.tenant.require();
    if (dailyBudgetUsd !== null && (!Number.isFinite(dailyBudgetUsd) || dailyBudgetUsd < 0)) {
      throw new ValidationError('dailyBudgetUsd must be null or a non-negative number');
    }
    return this.prisma.withTenant(t.organizationId, (tx) =>
      tx.organization.update({
        where: { id: t.organizationId },
        data: { dailyBudgetUsd: dailyBudgetUsd as any },
      }),
    );
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
