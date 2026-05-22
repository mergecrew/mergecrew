import { api } from '@/lib/api';
import { requireSession } from '@/lib/session';
import { Card, PageHead, Tile } from '@/components/ui';

interface SeriesPoint {
  day: string;
  runsStarted: number;
  runsCompleted: number;
  runsFailed: number;
  stepsRun: number;
  stepsPassed: number;
  p50StepMs: number;
  p95StepMs: number;
  costUsdCents: number;
}

interface MetricsResponse {
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
  deltas: {
    runsStarted: number | null;
    stepPassRate: number | null;
    p95StepMs: number | null;
    costUsdCents: number | null;
  };
}

const WINDOW_OPTIONS = ['7d', '30d'] as const;
type WindowOpt = (typeof WINDOW_OPTIONS)[number];

export default async function ProjectMetricsPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string; projectSlug: string }>;
  searchParams: Promise<{ window?: string }>;
}) {
  const { slug, projectSlug } = await params;
  const sp = await searchParams;
  const session = await requireSession();
  const window = normalizeWindow(sp.window);
  const [project, org] = await Promise.all([
    api<MetricsResponse>(
      `/v1/orgs/${slug}/projects/${projectSlug}/metrics?window=${window}`,
      { session },
    ),
    api<MetricsResponse>(`/v1/orgs/${slug}/metrics?window=${window}`, {
      session,
    }),
  ]);

  const empty =
    project.series.length === 0 && project.totals.stepsRun === 0;

  const projectPassRate =
    project.totals.stepsRun > 0
      ? (project.totals.stepsPassed / project.totals.stepsRun) * 100
      : null;
  const orgPassRate =
    org.totals.stepsRun > 0
      ? (org.totals.stepsPassed / org.totals.stepsRun) * 100
      : null;

  return (
    <main className="mx-auto max-w-[1280px] px-4 py-5 sm:px-9 sm:py-7">
      <PageHead
        crumb={[
          { label: slug, href: `/orgs/${slug}` },
          {
            label: projectSlug,
            href: `/orgs/${slug}/projects/${projectSlug}`,
          },
          { label: 'Metrics' },
        ]}
        title="Metrics"
        meta={
          <span className="font-mono text-[12.5px] text-muted">
            Project health · {project.days} day{project.days === 1 ? '' : 's'} in window
          </span>
        }
        actions={
          <WindowToggle slug={slug} projectSlug={projectSlug} current={window} />
        }
      />

      {empty ? (
        <Card className="px-6 py-10 text-center">
          <p className="m-0 text-[13px] text-muted">
            Metrics will appear within an hour of this project's first run.
          </p>
        </Card>
      ) : (
        <>
          <section className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-4">
            <Tile
              k="Runs"
              v={String(project.totals.runsStarted)}
              n={`${project.totals.runsCompleted} completed · ${project.totals.runsFailed} failed`}
              delta={formatDelta(project.deltas.runsStarted, 'pct')}
            />
            <PassRateTile
              projectRate={projectPassRate}
              orgRate={orgPassRate}
              stepsPassed={project.totals.stepsPassed}
              stepsRun={project.totals.stepsRun}
              delta={project.deltas.stepPassRate}
            />
            <LatencyTile
              p95={project.totals.avgP95StepMs}
              p50={project.totals.avgP50StepMs}
              orgP95={org.totals.avgP95StepMs}
              delta={project.deltas.p95StepMs}
            />
            <Tile
              k="Spend"
              v={formatUsdCents(project.totals.costUsdCents)}
              n="LLM cost in window"
              accent
              delta={formatDelta(project.deltas.costUsdCents, 'pct', true)}
            />
          </section>

          <section className="grid grid-cols-1 gap-6 md:grid-cols-2">
            <SeriesCard
              title="Runs per day"
              rows={project.series.map((p) => ({
                day: p.day,
                value: p.runsStarted,
                label: String(p.runsStarted),
              }))}
            />
            <SeriesCard
              title="Step pass rate per day"
              rows={project.series.map((p) => ({
                day: p.day,
                value:
                  p.stepsRun > 0 ? (p.stepsPassed / p.stepsRun) * 100 : 0,
                label:
                  p.stepsRun > 0
                    ? `${((p.stepsPassed / p.stepsRun) * 100).toFixed(0)}%`
                    : '—',
              }))}
              maxOverride={100}
            />
            <SeriesCard
              title="p95 step latency per day"
              rows={project.series.map((p) => ({
                day: p.day,
                value: p.p95StepMs,
                label: formatMs(p.p95StepMs),
              }))}
            />
            <SeriesCard
              title="Spend per day"
              rows={project.series.map((p) => ({
                day: p.day,
                value: p.costUsdCents,
                label: formatUsdCents(p.costUsdCents),
              }))}
            />
          </section>
        </>
      )}
    </main>
  );
}

function PassRateTile({
  projectRate,
  orgRate,
  stepsPassed,
  stepsRun,
  delta,
}: {
  projectRate: number | null;
  orgRate: number | null;
  stepsPassed: number;
  stepsRun: number;
  delta: number | null;
}) {
  return (
    <div className="border border-hair bg-paper px-[18px] py-[16px]">
      <span className="mb-[10px] flex items-center justify-between font-mono text-[10.5px] uppercase tracking-[0.1em] text-muted">
        <span>Step pass rate</span>
        {projectRate != null && orgRate != null && (
          <OrgCompareChip diff={projectRate - orgRate} unit="pp" />
        )}
      </span>
      <div
        className={
          'text-[26px] font-medium leading-none tracking-[-0.025em] whitespace-nowrap ' +
          (projectRate != null && projectRate >= 95
            ? 'text-positive-deep'
            : '')
        }
      >
        {projectRate != null ? `${projectRate.toFixed(1)}%` : '—'}
      </div>
      <div className="mt-[6px] truncate text-[12.5px] text-ink-2">
        {stepsPassed} / {stepsRun} steps
      </div>
      {delta != null && Math.abs(delta) >= 0.05 && (
        <div
          className={
            'mt-1 font-mono text-[11px] ' +
            (delta > 0 ? 'text-positive-deep' : 'text-energy-deep')
          }
        >
          {delta > 0 ? '↑ +' : '↓ −'}
          {Math.abs(delta).toFixed(1)}pp vs prior
        </div>
      )}
    </div>
  );
}

function LatencyTile({
  p95,
  p50,
  orgP95,
  delta,
}: {
  p95: number;
  p50: number;
  orgP95: number;
  delta: number | null;
}) {
  const diffPct =
    orgP95 > 0 && p95 > 0 ? ((p95 - orgP95) / orgP95) * 100 : null;
  return (
    <div className="border border-hair bg-paper px-[18px] py-[16px]">
      <span className="mb-[10px] flex items-center justify-between font-mono text-[10.5px] uppercase tracking-[0.1em] text-muted">
        <span>p95 step latency</span>
        {diffPct != null && (
          <OrgCompareChip diff={diffPct} unit="pct" invert />
        )}
      </span>
      <div className="text-[26px] font-medium leading-none tracking-[-0.025em] whitespace-nowrap">
        {p95 > 0 ? formatMs(p95) : '—'}
      </div>
      <div className="mt-[6px] truncate text-[12.5px] text-ink-2">
        p50 {formatMs(p50)}
      </div>
      {delta != null && Math.abs(delta) >= 0.05 && (
        <div
          className={
            'mt-1 font-mono text-[11px] ' +
            (delta < 0 ? 'text-positive-deep' : 'text-energy-deep')
          }
        >
          {delta > 0 ? '↑ +' : '↓ −'}
          {Math.abs(delta).toFixed(0)}% vs prior
        </div>
      )}
    </div>
  );
}

function OrgCompareChip({
  diff,
  unit,
  invert = false,
}: {
  diff: number;
  unit: 'pct' | 'pp';
  invert?: boolean;
}) {
  if (Math.abs(diff) < 0.05) {
    return (
      <span className="font-mono text-[10px] text-muted">≈ org avg</span>
    );
  }
  const above = diff > 0;
  // For latency/cost ("invert"), being above org avg is bad.
  const tone = (invert ? !above : above) ? 'text-positive-deep' : 'text-energy-deep';
  const sign = above ? '+' : '−';
  const value =
    unit === 'pp'
      ? `${sign}${Math.abs(diff).toFixed(1)}pp`
      : `${sign}${Math.abs(diff).toFixed(0)}%`;
  return (
    <span className={'font-mono text-[10px] ' + tone}>
      {value} vs org
    </span>
  );
}

function SeriesCard({
  title,
  rows,
  maxOverride,
}: {
  title: string;
  rows: { day: string; value: number; label: string }[];
  maxOverride?: number;
}) {
  const max = maxOverride ?? Math.max(0, ...rows.map((r) => r.value));
  return (
    <div>
      <div className="mb-3 font-mono text-[11px] uppercase tracking-[0.1em] text-muted">
        {title}
      </div>
      <Card className="p-5">
        {rows.length === 0 ? (
          <p className="m-0 text-[13px] text-muted">No data.</p>
        ) : (
          <ul className="m-0 space-y-2 list-none p-0">
            {rows.map((r) => (
              <li
                key={r.day}
                className="flex items-center gap-3 text-[13px]"
              >
                <span className="w-20 shrink-0 font-mono text-[11.5px] text-muted">
                  {formatDay(r.day)}
                </span>
                <span className="h-2 flex-1 bg-bg-2">
                  <span
                    className="block h-full bg-accent"
                    style={{
                      width: `${max > 0 ? (r.value / max) * 100 : 0}%`,
                    }}
                  />
                </span>
                <span className="w-20 shrink-0 text-right font-mono tabular-nums text-ink">
                  {r.label}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

function WindowToggle({
  slug,
  projectSlug,
  current,
}: {
  slug: string;
  projectSlug: string;
  current: WindowOpt;
}) {
  return (
    <div className="flex gap-1 border border-hair bg-paper p-[2px] font-mono text-[11px]">
      {WINDOW_OPTIONS.map((w) => (
        <a
          key={w}
          href={`/orgs/${slug}/projects/${projectSlug}/metrics?window=${w}`}
          className={
            'px-[10px] py-[4px] no-underline ' +
            (w === current ? 'bg-ink text-paper' : 'text-ink-2 hover:bg-bg')
          }
        >
          {w}
        </a>
      ))}
    </div>
  );
}

function normalizeWindow(raw?: string): WindowOpt {
  return raw === '7d' ? '7d' : '30d';
}

function formatDay(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
  });
}

function formatMs(ms: number): string {
  if (ms >= 60_000) return `${(ms / 60_000).toFixed(1)}m`;
  if (ms >= 1_000) return `${(ms / 1_000).toFixed(1)}s`;
  return `${ms}ms`;
}

function formatUsdCents(cents: number): string {
  const usd = cents / 100;
  if (usd === 0) return '$0.00';
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  if (usd < 1) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(2)}`;
}

function formatDelta(
  delta: number | null,
  unit: 'pct' | 'pp',
  invert = false,
): { dir: 'up' | 'down'; label: string } | undefined {
  if (delta == null || Number.isNaN(delta)) return undefined;
  if (Math.abs(delta) < 0.05) return undefined;
  const rising = delta > 0;
  const dir = (invert ? !rising : rising) ? 'up' : 'down';
  const sign = rising ? '+' : '−';
  const value =
    unit === 'pp'
      ? `${sign}${Math.abs(delta).toFixed(1)}pp`
      : `${sign}${Math.abs(delta).toFixed(0)}%`;
  return { dir, label: `${value} vs prior` };
}
