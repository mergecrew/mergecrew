import { Injectable } from '@nestjs/common';
import { NotFoundError } from '@mergecrew/domain';
import { PrismaService } from '../../common/prisma.service.js';
import { TenantContextService } from '../../common/tenant-context.service.js';

@Injectable()
export class EvalService {
  constructor(private prisma: PrismaService, private tenant: TenantContextService) {}

  /**
   * Recent eval runs for the dashboard (#301). Returns aggregate stats
   * + the run id; per-fixture case rows come via `detail(runId)`.
   */
  async list(opts: { limit?: number } = {}) {
    const t = this.tenant.require();
    const take = Math.max(1, Math.min(opts.limit ?? 10, 50));
    const rows = await this.prisma.withTenant(t.organizationId, (tx) =>
      tx.evalRun.findMany({
        where: { organizationId: t.organizationId },
        orderBy: { startedAt: 'desc' },
        take,
      }),
    );
    return rows.map((r) => ({
      ...r,
      totalUsd: Number(r.totalUsd),
    }));
  }

  /**
   * Trailing pass-rate stats over the last 7 days (#301 + #304). Used
   * by the dashboard header and the regression-alert detector. Returns
   * the per-day pass-rate so a sparkline can render directly.
   */
  async trailingPassRate(days = 7) {
    const t = this.tenant.require();
    const since = new Date(Date.now() - days * 86_400_000);
    const rows = await this.prisma.withTenant(t.organizationId, (tx) =>
      tx.evalRun.findMany({
        where: {
          organizationId: t.organizationId,
          startedAt: { gte: since },
          finishedAt: { not: null },
        },
        select: {
          startedAt: true,
          totalCases: true,
          passCount: true,
          failCount: true,
          errorCount: true,
        },
        orderBy: { startedAt: 'asc' },
      }),
    );
    const totals = rows.reduce(
      (acc, r) => {
        acc.cases += r.totalCases;
        acc.pass += r.passCount;
        return acc;
      },
      { cases: 0, pass: 0 },
    );
    return {
      windowDays: days,
      runCount: rows.length,
      passRate: totals.cases > 0 ? totals.pass / totals.cases : null,
      perRun: rows.map((r) => ({
        startedAt: r.startedAt,
        passRate: r.totalCases > 0 ? r.passCount / r.totalCases : null,
      })),
    };
  }

  /**
   * Full detail for a single run (#301). Cases sorted by fixtureId for
   * stable rendering. The dashboard expands failing cases inline; their
   * agentDiff is included verbatim.
   */
  async detail(runId: string) {
    const t = this.tenant.require();
    const run = await this.prisma.withTenant(t.organizationId, (tx) =>
      tx.evalRun.findFirst({
        where: { id: runId, organizationId: t.organizationId },
      }),
    );
    if (!run) throw new NotFoundError();
    const cases = await this.prisma.withTenant(t.organizationId, (tx) =>
      tx.evalCase.findMany({
        where: { evalRunId: run.id },
        orderBy: { fixtureId: 'asc' },
      }),
    );
    return {
      run: { ...run, totalUsd: Number(run.totalUsd) },
      cases: cases.map((c) => ({ ...c, usdEstimate: Number(c.usdEstimate) })),
    };
  }
}
