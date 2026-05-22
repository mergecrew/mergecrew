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

export default async function MetricsPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ window?: string }>;
}) {
  const { slug } = await params;
  const sp = await searchParams;
  const session = await requireSession();
  const window = normalizeWindow(sp.window);
  const data = await api<MetricsResponse>(
    `/v1/orgs/${slug}/metrics?window=${window}`,
    { session },
  );

  const empty = data.series.length === 0 && data.totals.stepsRun === 0;
  const passRate =
    data.totals.stepsRun > 0
      ? (data.totals.stepsPassed / data.totals.stepsRun) * 100
      : null;
  const failRate =
    data.totals.runsStarted > 0
      ? (data.totals.runsFailed / data.totals.runsStarted) * 100
      : null;

  return (
    <main className="mx-auto max-w-[1280px] px-4 py-5 sm:px-9 sm:py-7">
      <PageHead
        crumb={[
          { label: slug, href: `/orgs/${slug}` },
          { label: 'Metrics' },
        ]}
        title="Metrics"
        meta={
          <span className="font-mono text-[12.5px] text-muted">
            Org-wide health · {data.days} day{data.days === 1 ? '' : 's'} in window
          </span>
        }
        actions={<WindowToggle slug={slug} current={window} />}
      />

      {empty ? (
        <Card className="px-6 py-10 text-center">
          <p className="m-0 text-[13px] text-muted">
            Metrics will appear within an hour of your first run.
          </p>
        </Card>
      ) : (
        <>
          <section className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-4">
            <Tile
              k="Runs"
              v={String(data.totals.runsStarted)}
              n={`${data.totals.runsCompleted} completed · ${data.totals.runsFailed} failed`}
              delta={formatDelta(data.deltas.runsStarted, 'pct')}
            />
            <Tile
              k="Step pass rate"
              v={passRate != null ? `${passRate.toFixed(1)}%` : '—'}
              n={`${data.totals.stepsPassed} / ${data.totals.stepsRun} steps`}
              positive={passRate != null && passRate >= 95}
              delta={formatDelta(data.deltas.stepPassRate, 'pp')}
            />
            <Tile
              k="p95 step latency"
              v={data.totals.avgP95StepMs > 0 ? formatMs(data.totals.avgP95StepMs) : '—'}
              n={`p50 ${formatMs(data.totals.avgP50StepMs)}`}
              delta={formatDelta(data.deltas.p95StepMs, 'pct', /* invert */ true)}
            />
            <Tile
              k="Spend"
              v={formatUsdCents(data.totals.costUsdCents)}
              n="LLM cost in window"
              accent
              delta={formatDelta(data.deltas.costUsdCents, 'pct', /* invert */ true)}
            />
          </section>

          <section className="grid grid-cols-1 gap-6 md:grid-cols-2">
            <SeriesCard
              title="Runs per day"
              rows={data.series.map((p) => ({
                day: p.day,
                value: p.runsStarted,
                label: String(p.runsStarted),
              }))}
            />
            <SeriesCard
              title="Step pass rate per day"
              rows={data.series.map((p) => ({
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
              rows={data.series.map((p) => ({
                day: p.day,
                value: p.p95StepMs,
                label: formatMs(p.p95StepMs),
              }))}
            />
            <SeriesCard
              title="Spend per day"
              rows={data.series.map((p) => ({
                day: p.day,
                value: p.costUsdCents,
                label: formatUsdCents(p.costUsdCents),
              }))}
            />
          </section>

          {failRate != null && failRate > 0 && (
            <p className="mt-6 font-mono text-[11.5px] text-muted">
              Failure rate {failRate.toFixed(1)}% over the window.
            </p>
          )}
        </>
      )}
    </main>
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

function WindowToggle({ slug, current }: { slug: string; current: WindowOpt }) {
  return (
    <div className="flex gap-1 border border-hair bg-paper p-[2px] font-mono text-[11px]">
      {WINDOW_OPTIONS.map((w) => (
        <a
          key={w}
          href={`/orgs/${slug}/metrics?window=${w}`}
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
  // For metrics where smaller is better (latency, cost), flip the dir so
  // a fall reads as positive in the UI.
  const dir = (invert ? !rising : rising) ? 'up' : 'down';
  const sign = rising ? '+' : '−';
  const value =
    unit === 'pp'
      ? `${sign}${Math.abs(delta).toFixed(1)}pp`
      : `${sign}${Math.abs(delta).toFixed(0)}%`;
  return { dir, label: `${value} vs prior` };
}
