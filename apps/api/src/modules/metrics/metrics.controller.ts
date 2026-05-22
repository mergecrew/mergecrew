import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { PrismaService } from '../../common/prisma.service.js';
import { TenantContextService } from '../../common/tenant-context.service.js';
import { RoleGuard } from '../../common/role.guard.js';
import { NotFoundError } from '@mergecrew/domain';

type SeriesPoint = {
  day: string;
  runsStarted: number;
  runsCompleted: number;
  runsFailed: number;
  stepsRun: number;
  stepsPassed: number;
  p50StepMs: number;
  p95StepMs: number;
  costUsdCents: number;
};

type MetricsSummary = {
  window: '7d' | '30d';
  days: number;
  series: SeriesPoint[];
  totals: {
    runsStarted: number;
    runsCompleted: number;
    runsFailed: number;
    stepsRun: number;
    stepsPassed: number;
    avgP50StepMs: number;
    avgP95StepMs: number;
    costUsdCents: number;
  };
  /**
   * Deltas vs the equivalent previous window (e.g. 7d window compared to
   * the 7 days before that). `null` when there's not enough history.
   */
  deltas: {
    runsStarted: number | null;
    stepPassRate: number | null;
    p95StepMs: number | null;
    costUsdCents: number | null;
  };
};

const WINDOW_DAYS: Record<'7d' | '30d', number> = { '7d': 7, '30d': 30 };

@Controller('v1/orgs/:slug')
@UseGuards(RoleGuard)
export class MetricsController {
  constructor(
    private prisma: PrismaService,
    private tenant: TenantContextService,
  ) {}

  @Get('metrics')
  async orgMetrics(@Query('window') windowQ?: string): Promise<MetricsSummary> {
    const t = this.tenant.require();
    const window = normalizeWindow(windowQ);
    const days = WINDOW_DAYS[window];
    return this.summarize({ organizationId: t.organizationId, projectId: null, days, window });
  }

  @Get('projects/:projectSlug/metrics')
  async projectMetrics(
    @Param('projectSlug') projectSlug: string,
    @Query('window') windowQ?: string,
  ): Promise<MetricsSummary> {
    const t = this.tenant.require();
    const project = await this.prisma.withTenant(t.organizationId, (tx) =>
      tx.project.findFirst({
        where: { slug: projectSlug, organizationId: t.organizationId },
        select: { id: true },
      }),
    );
    if (!project) throw new NotFoundError();
    const window = normalizeWindow(windowQ);
    const days = WINDOW_DAYS[window];
    return this.summarize({
      organizationId: t.organizationId,
      projectId: project.id,
      days,
      window,
    });
  }

  private async summarize(opts: {
    organizationId: string;
    projectId: string | null;
    days: number;
    window: '7d' | '30d';
  }): Promise<MetricsSummary> {
    const { organizationId, projectId, days, window } = opts;
    const now = new Date();
    const todayStart = new Date(now);
    todayStart.setUTCHours(0, 0, 0, 0);
    const windowStart = new Date(todayStart.getTime() - days * 86_400_000);
    const previousStart = new Date(windowStart.getTime() - days * 86_400_000);

    const rows = await this.prisma.withTenant(organizationId, (tx) =>
      tx.metricsRollup.findMany({
        where: {
          organizationId,
          projectId,
          granularity: 'day',
          bucket: { gte: previousStart, lt: todayStart },
        },
        orderBy: { bucket: 'asc' },
      }),
    );

    const current = rows.filter((r) => r.bucket >= windowStart);
    const previous = rows.filter((r) => r.bucket < windowStart);

    const series: SeriesPoint[] = current.map((r) => ({
      day: r.bucket.toISOString().slice(0, 10),
      runsStarted: r.runsStarted,
      runsCompleted: r.runsCompleted,
      runsFailed: r.runsFailed,
      stepsRun: r.stepsRun,
      stepsPassed: r.stepsPassed,
      p50StepMs: r.p50StepMs,
      p95StepMs: r.p95StepMs,
      costUsdCents: Number(r.costUsdCents),
    }));

    const totals = aggregate(series);
    const prevTotals = aggregate(
      previous.map((r) => ({
        day: r.bucket.toISOString().slice(0, 10),
        runsStarted: r.runsStarted,
        runsCompleted: r.runsCompleted,
        runsFailed: r.runsFailed,
        stepsRun: r.stepsRun,
        stepsPassed: r.stepsPassed,
        p50StepMs: r.p50StepMs,
        p95StepMs: r.p95StepMs,
        costUsdCents: Number(r.costUsdCents),
      })),
    );

    const deltas = {
      runsStarted: pctDelta(totals.runsStarted, prevTotals.runsStarted),
      stepPassRate: passRateDelta(totals, prevTotals),
      p95StepMs: pctDelta(totals.avgP95StepMs, prevTotals.avgP95StepMs),
      costUsdCents: pctDelta(totals.costUsdCents, prevTotals.costUsdCents),
    };

    return { window, days, series, totals, deltas };
  }
}

function normalizeWindow(raw?: string): '7d' | '30d' {
  return raw === '7d' ? '7d' : '30d';
}

function aggregate(series: SeriesPoint[]): MetricsSummary['totals'] {
  const sum = series.reduce(
    (a, r) => ({
      runsStarted: a.runsStarted + r.runsStarted,
      runsCompleted: a.runsCompleted + r.runsCompleted,
      runsFailed: a.runsFailed + r.runsFailed,
      stepsRun: a.stepsRun + r.stepsRun,
      stepsPassed: a.stepsPassed + r.stepsPassed,
      p50Sum: a.p50Sum + r.p50StepMs,
      p95Sum: a.p95Sum + r.p95StepMs,
      costUsdCents: a.costUsdCents + r.costUsdCents,
      withSteps: a.withSteps + (r.stepsRun > 0 ? 1 : 0),
    }),
    {
      runsStarted: 0,
      runsCompleted: 0,
      runsFailed: 0,
      stepsRun: 0,
      stepsPassed: 0,
      p50Sum: 0,
      p95Sum: 0,
      costUsdCents: 0,
      withSteps: 0,
    },
  );
  const denom = sum.withSteps || 1;
  return {
    runsStarted: sum.runsStarted,
    runsCompleted: sum.runsCompleted,
    runsFailed: sum.runsFailed,
    stepsRun: sum.stepsRun,
    stepsPassed: sum.stepsPassed,
    avgP50StepMs: Math.round(sum.p50Sum / denom),
    avgP95StepMs: Math.round(sum.p95Sum / denom),
    costUsdCents: sum.costUsdCents,
  };
}

function pctDelta(curr: number, prev: number): number | null {
  if (prev === 0) return curr === 0 ? 0 : null;
  return ((curr - prev) / prev) * 100;
}

function passRateDelta(
  curr: MetricsSummary['totals'],
  prev: MetricsSummary['totals'],
): number | null {
  if (curr.stepsRun === 0 || prev.stepsRun === 0) return null;
  const currRate = curr.stepsPassed / curr.stepsRun;
  const prevRate = prev.stepsPassed / prev.stepsRun;
  // Absolute percentage-point change so the UI can show "+1.2pp".
  return (currRate - prevRate) * 100;
}
