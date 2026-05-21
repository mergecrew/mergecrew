import Link from 'next/link';
import { api } from '@/lib/api';
import { requireSession } from '@/lib/session';
import { Card, PageHead, Tile, Label } from '@/components/ui';
import { relativeTime } from '@/lib/format';

interface EvalRunRow {
  id: string;
  startedAt: string;
  finishedAt: string | null;
  source: string;
  totalCases: number;
  passCount: number;
  failCount: number;
  errorCount: number;
  totalUsd: number;
  totalLatencyMs: number;
}

interface Trailing {
  windowDays: number;
  runCount: number;
  passRate: number | null;
  perRun: Array<{ startedAt: string; passRate: number | null }>;
}

function fmtPct(rate: number | null): string {
  if (rate == null) return '—';
  return `${(rate * 100).toFixed(1)}%`;
}

function rateToneClass(rate: number | null): string {
  if (rate == null) return 'text-muted';
  if (rate >= 0.95) return 'text-positive-deep';
  if (rate >= 0.8) return 'text-ink';
  return 'text-energy-deep';
}

export default async function EvalsPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const session = await requireSession();
  const data = await api<{ items: EvalRunRow[]; trailing: Trailing }>(
    `/v1/orgs/${slug}/evals?limit=20`,
    { session },
  );
  const trailing = data.trailing;
  const items = data.items ?? [];

  const totalCases = items.reduce((s, r) => s + r.totalCases, 0);
  const totalFailures = items.reduce((s, r) => s + r.failCount + r.errorCount, 0);
  const totalCost = items.reduce((s, r) => s + r.totalUsd, 0);

  return (
    <main className="mx-auto max-w-[1280px] px-9 py-7">
      <PageHead
        crumb={[
          { label: slug, href: `/orgs/${slug}` },
          { label: 'Evals' },
        ]}
        title="Evals"
        meta={
          <span className="font-mono text-[12.5px] text-muted">
            {items.length} recent runs · trailing {trailing.windowDays}d
          </span>
        }
        actions={
          <a
            href="https://github.com/mergecrew/mergecrew/blob/main/docs/03-infrastructure/15-evals.md"
            target="_blank"
            rel="noreferrer"
            className="text-[12.5px] text-muted underline-offset-[3px] hover:text-ink hover:underline"
          >
            Eval cookbook →
          </a>
        }
      />

      <section className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-4">
        <Tile
          k={`Trailing ${trailing.windowDays}d`}
          v={fmtPct(trailing.passRate)}
          positive={trailing.passRate != null && trailing.passRate >= 0.95}
          energy={trailing.passRate != null && trailing.passRate < 0.8}
        />
        <Tile k="Runs" v={String(trailing.runCount)} />
        <Tile k="Cases" v={String(totalCases)} n={`${totalFailures} failures`} />
        <Tile k="Spent" v={`$${totalCost.toFixed(2)}`} accent />
      </section>

      <Card className="mb-6 p-5">
        <Label className="block mb-3">Trailing pass-rate sparkline</Label>
        {trailing.perRun.length === 0 ? (
          <p className="m-0 text-[13px] text-muted">No runs yet in the window.</p>
        ) : (
          <div className="flex h-14 items-end gap-[3px]">
            {trailing.perRun.map((r, i) => {
              const h = r.passRate == null ? 0 : Math.max(4, r.passRate * 100);
              const color =
                r.passRate == null
                  ? 'bg-hair-strong'
                  : r.passRate >= 0.95
                    ? 'bg-positive'
                    : r.passRate >= 0.8
                      ? 'bg-warn'
                      : 'bg-energy';
              return (
                <div
                  key={i}
                  className={`flex-1 min-h-[2px] ${color}`}
                  style={{ height: `${h}%` }}
                  title={`${new Date(r.startedAt).toLocaleString()}: ${fmtPct(r.passRate)}`}
                />
              );
            })}
          </div>
        )}
        <p className="mt-3 m-0 font-mono text-[11.5px] text-muted">
          oldest → newest · hover for pass-rate
        </p>
      </Card>

      <div className="mb-3 font-mono text-[11px] uppercase tracking-[0.1em] text-muted">
        Recent runs
      </div>
      <Card>
        {items.length === 0 ? (
          <div className="p-5 text-[13px] text-muted">
            No eval runs yet. Trigger one with{' '}
            <code className="font-mono text-[12px] text-ink">
              pnpm --filter @mergecrew/eval-runner run -- --org {slug}
            </code>
            .
          </div>
        ) : (
          <ul className="m-0 list-none p-0">
            <li className="hidden border-b border-ink px-5 py-2 font-mono text-[10.5px] uppercase tracking-[0.06em] text-muted md:grid md:grid-cols-[100px_110px_70px_70px_70px_100px_90px_1fr] md:gap-3">
              <span>Started</span>
              <span>Source</span>
              <span>Cases</span>
              <span>Pass</span>
              <span>Fail</span>
              <span>Rate</span>
              <span>Cost</span>
              <span>Latency</span>
            </li>
            {items.map((r, i) => {
              const rate = r.totalCases > 0 ? r.passCount / r.totalCases : null;
              return (
                <li
                  key={r.id}
                  className={i < items.length - 1 ? 'border-b border-hair-2' : ''}
                >
                  <Link
                    href={`/orgs/${slug}/evals/${r.id}`}
                    className="grid grid-cols-1 items-center gap-2 px-5 py-3 text-[13px] text-ink no-underline hover:bg-paper-2 md:grid-cols-[100px_110px_70px_70px_70px_100px_90px_1fr] md:gap-3"
                  >
                    <span className="font-mono text-[11.5px] text-muted">
                      {relativeTime(r.startedAt)}
                    </span>
                    <span className="bg-accent-tint px-[8px] py-[2px] font-mono text-[10.5px] uppercase tracking-[0.06em] text-accent-deep">
                      {r.source}
                    </span>
                    <span className="font-mono text-[12px]">{r.totalCases}</span>
                    <span className="font-mono text-[12px] text-positive-deep">
                      {r.passCount}
                    </span>
                    <span className="font-mono text-[12px] text-energy-deep">
                      {r.failCount}
                    </span>
                    <span
                      className={`font-mono text-[13px] font-semibold ${rateToneClass(rate)}`}
                    >
                      {fmtPct(rate)}
                    </span>
                    <span className="font-mono text-[12px] text-ink">
                      ${r.totalUsd.toFixed(2)}
                    </span>
                    <span className="font-mono text-[11.5px] text-muted">
                      {(r.totalLatencyMs / 1000).toFixed(1)}s
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </Card>
    </main>
  );
}
