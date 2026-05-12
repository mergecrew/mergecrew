import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { NotFoundError, ValidationError } from '@mergecrew/domain';
import { PrismaService } from '../../common/prisma.service.js';
import { TenantContextService } from '../../common/tenant-context.service.js';
import { TelemetryService } from '../../common/telemetry.service.js';

function startOfUtcDay(d: Date): Date {
  const r = new Date(d);
  r.setUTCHours(0, 0, 0, 0);
  return r;
}

function startOfUtcMonth(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}

@Injectable()
export class OrgService {
  constructor(
    private prisma: PrismaService,
    private tenant: TenantContextService,
    private telemetry: TelemetryService,
  ) {}

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
    // No-op unless this org later opts in to telemetry (#253). The
    // emit is fire-and-forget so a misconfigured transport can't
    // affect the create return path.
    void this.telemetry.emit(org.id, 'org.created', {});
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

  /**
   * Rename the org or change its slug. Both fields are optional; pass
   * only what changed. Slug must be lowercase a-z0-9-, 2–48 chars, and
   * unique across all orgs (it's already a Postgres unique key but we
   * surface the conflict as a friendly ValidationError).
   *
   * Cascade: nothing else references org by slug — projects, runs,
   * changesets, etc. all key on the org's UUID — so a slug change is
   * safe DB-wise. Callers (BFF) need to redirect the user to the new
   * URL after the response.
   */
  async update(patch: { name?: string; slug?: string }) {
    const t = this.tenant.require();
    const data: { name?: string; slug?: string } = {};

    if (patch.name !== undefined) {
      const trimmed = patch.name.trim();
      if (!trimmed) throw new ValidationError('name cannot be empty');
      if (trimmed.length > 80) throw new ValidationError('name is too long (max 80 chars)');
      data.name = trimmed;
    }

    if (patch.slug !== undefined) {
      const next = patch.slug.trim().toLowerCase();
      if (!/^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$/.test(next)) {
        throw new ValidationError(
          'slug must be 2–48 chars, lowercase a-z0-9, with hyphens between (no leading/trailing hyphen)',
        );
      }
      // Unique-check up front so the error code is clear; the DB unique
      // index is the actual enforcement.
      const conflict = await this.prisma.withSystem((tx) =>
        tx.organization.findFirst({
          where: { slug: next, NOT: { id: t.organizationId } },
          select: { id: true },
        }),
      );
      if (conflict) throw new ValidationError(`slug "${next}" is taken`);
      data.slug = next;
    }

    if (Object.keys(data).length === 0) {
      // No-op patch — return the current row rather than hit the DB for
      // an empty update.
      return this.detail();
    }

    return this.prisma.withTenant(t.organizationId, (tx) =>
      tx.organization.update({ where: { id: t.organizationId }, data }),
    );
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

  /**
   * Sum of `usd_estimate` for the current org's LLM invocations since
   * UTC midnight on the 1st of the current month. Used to enforce
   * `monthlySpendCapUsd` (#282).
   */
  async monthToDateSpendUsd(): Promise<number> {
    const t = this.tenant.require();
    const since = startOfUtcMonth(new Date());
    const rows = await this.prisma.withTenant(t.organizationId, (tx) =>
      tx.llmInvocation.aggregate({
        where: { organizationId: t.organizationId, occurredAt: { gte: since } },
        _sum: { usdEstimate: true },
      }),
    );
    return Number(rows._sum.usdEstimate ?? 0);
  }

  /**
   * Trailing 7-day average daily spend (#283). Sums LlmInvocation cost
   * over the prior `days` days (excluding today, which is partial) and
   * divides. Returns 0 when there's no history yet.
   */
  async trailingDailyAvgUsd(days = 7): Promise<number> {
    const t = this.tenant.require();
    const now = new Date();
    const startOfToday = startOfUtcDay(now);
    const windowStart = new Date(startOfToday.getTime() - days * 24 * 3600_000);
    const rows = await this.prisma.withTenant(t.organizationId, (tx) =>
      tx.llmInvocation.aggregate({
        where: {
          organizationId: t.organizationId,
          occurredAt: { gte: windowStart, lt: startOfToday },
        },
        _sum: { usdEstimate: true },
      }),
    );
    return Number(rows._sum.usdEstimate ?? 0) / days;
  }

  /**
   * Returns the current cap setting + month-to-date spend + trailing
   * 7-day forecast (#283). The settings card renders the projection
   * inline; the org dashboard surfaces a banner when projection ≥ cap.
   *
   * `daysToCapExceedance` is the projected day-of-month the cap would
   * be hit at the current pace. Null when there's no cap or the cap
   * isn't projected to be hit this month.
   */
  async getSpendCap(): Promise<{
    monthlySpendCapUsd: number | null;
    monthToDateUsd: number;
    trailing7DayAvgUsd: number;
    projectedMonthEndUsd: number;
    daysToCapExceedance: number | null;
    projectionExceedsCap: boolean;
  }> {
    const t = this.tenant.require();
    const row = await this.prisma.withTenant(t.organizationId, (tx) =>
      tx.organization.findUnique({
        where: { id: t.organizationId },
        select: { monthlySpendCapUsd: true },
      }),
    );
    const cap =
      row?.monthlySpendCapUsd === null || row?.monthlySpendCapUsd === undefined
        ? null
        : Number(row.monthlySpendCapUsd);
    const [monthToDateUsd, trailing7DayAvgUsd] = await Promise.all([
      this.monthToDateSpendUsd(),
      this.trailingDailyAvgUsd(7),
    ]);
    const now = new Date();
    const daysInMonth = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0),
    ).getUTCDate();
    const today = now.getUTCDate();
    const daysRemaining = Math.max(0, daysInMonth - today);
    const projectedMonthEndUsd = monthToDateUsd + trailing7DayAvgUsd * daysRemaining;
    let daysToCapExceedance: number | null = null;
    let projectionExceedsCap = false;
    if (cap !== null && trailing7DayAvgUsd > 0 && projectedMonthEndUsd > cap) {
      projectionExceedsCap = true;
      const usdToCap = Math.max(0, cap - monthToDateUsd);
      const daysToHit = Math.ceil(usdToCap / trailing7DayAvgUsd);
      daysToCapExceedance = Math.min(daysInMonth, today + daysToHit);
    }
    return {
      monthlySpendCapUsd: cap,
      monthToDateUsd,
      trailing7DayAvgUsd,
      projectedMonthEndUsd,
      daysToCapExceedance,
      projectionExceedsCap,
    };
  }

  /**
   * Nightly eval cron opt-in (#303). Off by default; toggling on
   * doesn't trigger an immediate run — worker-cron picks the org up
   * on its next daily tick. lastRanAt is read-only via this surface
   * (worker-cron owns the bump).
   */
  async getEvalsSettings(): Promise<{ enabled: boolean; lastRanAt: string | null }> {
    const t = this.tenant.require();
    const row = await this.prisma.withTenant(t.organizationId, (tx) =>
      tx.organization.findUnique({
        where: { id: t.organizationId },
        select: { evalsEnabled: true, evalsLastRanAt: true },
      }),
    );
    return {
      enabled: row?.evalsEnabled ?? false,
      lastRanAt: row?.evalsLastRanAt ? row.evalsLastRanAt.toISOString() : null,
    };
  }

  async updateEvalsSettings(enabled: boolean): Promise<{ enabled: boolean; lastRanAt: string | null }> {
    const t = this.tenant.require();
    await this.prisma.withTenant(t.organizationId, (tx) =>
      tx.organization.update({
        where: { id: t.organizationId },
        data: { evalsEnabled: enabled },
      }),
    );
    return this.getEvalsSettings();
  }

  async updateSpendCap(monthlySpendCapUsd: number | null) {
    const t = this.tenant.require();
    if (monthlySpendCapUsd !== null && (!Number.isFinite(monthlySpendCapUsd) || monthlySpendCapUsd < 0)) {
      throw new ValidationError('monthlySpendCapUsd must be null or a non-negative number');
    }
    return this.prisma.withTenant(t.organizationId, (tx) =>
      tx.organization.update({
        where: { id: t.organizationId },
        data: { monthlySpendCapUsd: monthlySpendCapUsd as any },
      }),
    );
  }

  /**
   * Anonymous-usage telemetry opt-in (#253). Toggling on lazily
   * generates the per-install random UUID stored in
   * `telemetry_install_id`; toggling off leaves the id intact so a
   * later re-opt-in stays under the same id (lets the receiver
   * de-duplicate flap without us recording anything else).
   */
  async getTelemetrySettings(): Promise<{ enabled: boolean; installId: string | null }> {
    const t = this.tenant.require();
    const row = await this.prisma.withTenant(t.organizationId, (tx) =>
      tx.organization.findUnique({
        where: { id: t.organizationId },
        select: { telemetryEnabled: true, telemetryInstallId: true },
      }),
    );
    return {
      enabled: row?.telemetryEnabled ?? false,
      installId: row?.telemetryInstallId ?? null,
    };
  }

  async updateTelemetry(enabled: boolean): Promise<{ enabled: boolean; installId: string | null }> {
    const t = this.tenant.require();
    const current = await this.prisma.withTenant(t.organizationId, (tx) =>
      tx.organization.findUnique({
        where: { id: t.organizationId },
        select: { telemetryInstallId: true },
      }),
    );
    const installId = enabled && !current?.telemetryInstallId ? randomUUID() : current?.telemetryInstallId ?? null;
    await this.prisma.withTenant(t.organizationId, (tx) =>
      tx.organization.update({
        where: { id: t.organizationId },
        data: { telemetryEnabled: enabled, telemetryInstallId: installId },
      }),
    );
    await this.prisma.withTenant(t.organizationId, (tx) =>
      tx.auditLogEntry.create({
        data: {
          organizationId: t.organizationId,
          actorUserId: t.userId,
          action: enabled ? 'org.telemetry.enabled' : 'org.telemetry.disabled',
          target: { organizationId: t.organizationId },
          metadata: {},
        },
      }),
    );
    return { enabled, installId };
  }

  async updateConcurrencyCap(orgConcurrencyCap: number) {
    const t = this.tenant.require();
    if (!Number.isInteger(orgConcurrencyCap) || orgConcurrencyCap < 0) {
      throw new ValidationError('orgConcurrencyCap must be a non-negative integer (0 = unlimited)');
    }
    return this.prisma.withTenant(t.organizationId, (tx) =>
      tx.organization.update({
        where: { id: t.organizationId },
        data: { orgConcurrencyCap },
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

  /**
   * Onboarding checklist (#382, V2.ah). Computes the next-action state
   * for the org by inspecting existing DB rows — no separate progress
   * tracker that could drift from reality. The seeded demo project
   * (slug='acme') is filtered out so its pre-wired demo-mode rows
   * don't mark per-project steps complete.
   *
   * Steps:
   *   - llm_provider:    any non-stub LlmProvider on the org
   *   - first_project:   any non-demo Project on the org
   *   - connected_repo:  the first non-demo project has a ConnectedRepo
   *   - deploy_target:   that same project has a dev DeployTarget
   */
  async onboarding(orgSlug: string): Promise<{
    steps: Array<{
      key: 'llm_provider' | 'first_project' | 'connected_repo' | 'deploy_target';
      label: string;
      status: 'complete' | 'pending';
      actionUrl: string;
    }>;
    complete: boolean;
  }> {
    const t = this.tenant.require();
    const data = await this.prisma.withTenant(t.organizationId, async (tx) => {
      const llm = await tx.llmProvider.count({ where: { organizationId: t.organizationId } });
      // Order projects by createdAt asc, then pick the first non-demo
      // (slug !== 'acme'). The demo project ships fully wired under
      // MERGECREW_DEMO_MODE, so leaving it in would mark every step
      // complete and hide the wizard for new installs.
      const projects = await tx.project.findMany({
        where: { organizationId: t.organizationId, deletedAt: null, slug: { not: 'acme' } },
        orderBy: { createdAt: 'asc' },
        select: {
          id: true,
          slug: true,
          connectedRepo: { select: { id: true } },
          deployTargets: { select: { kind: true }, where: { kind: 'dev' } },
        },
        take: 1,
      });
      return { llm, project: projects[0] ?? null };
    });

    const projectPath = data.project ? `/orgs/${orgSlug}/projects/${data.project.slug}` : null;
    const steps = [
      {
        key: 'llm_provider' as const,
        label: 'Add an LLM provider',
        status: data.llm > 0 ? ('complete' as const) : ('pending' as const),
        actionUrl: `/orgs/${orgSlug}/settings/llm-providers`,
      },
      {
        key: 'first_project' as const,
        label: 'Create your first project',
        status: data.project ? ('complete' as const) : ('pending' as const),
        actionUrl: `/orgs/${orgSlug}/projects/new`,
      },
      {
        key: 'connected_repo' as const,
        label: 'Connect a repo',
        status:
          data.project && data.project.connectedRepo ? ('complete' as const) : ('pending' as const),
        actionUrl: projectPath ? `${projectPath}/settings` : `/orgs/${orgSlug}/projects/new`,
      },
      {
        key: 'deploy_target' as const,
        label: 'Add a dev deploy target',
        status:
          data.project && data.project.deployTargets.length > 0
            ? ('complete' as const)
            : ('pending' as const),
        actionUrl: projectPath ? `${projectPath}/settings` : `/orgs/${orgSlug}/projects/new`,
      },
    ];
    return { steps, complete: steps.every((s) => s.status === 'complete') };
  }
}
