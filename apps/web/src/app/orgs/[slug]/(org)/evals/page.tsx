import Link from 'next/link';
import { api } from '@/lib/api';
import { requireSession } from '@/lib/session';
import { Card, Chip } from '@/components/ui';
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

function passRateChipKind(rate: number | null): 'low' | 'medium' | 'high' | 'neutral' {
  if (rate == null) return 'neutral';
  if (rate >= 0.95) return 'low'; // green
  if (rate >= 0.8) return 'medium'; // amber
  return 'high'; // red
}

function fmtPct(rate: number | null): string {
  if (rate == null) return '—';
  return `${(rate * 100).toFixed(1)}%`;
}

export default async function EvalsPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const session = await requireSession();
  const data = await api<{ items: EvalRunRow[]; trailing: Trailing }>(
    `/v1/orgs/${slug}/evals?limit=20`,
    { session },
  );
  const trailing = data.trailing;

  return (
    <main className="mx-auto max-w-3xl space-y-4 p-6">
      <header className="flex items-baseline justify-between">
        <h1 className="text-xl font-semibold">Evals</h1>
        <a
          href="https://github.com/mergecrew/mergecrew/blob/main/docs/03-infrastructure/15-evals.md"
          target="_blank"
          rel="noreferrer"
          className="text-xs text-zinc-500 underline decoration-dotted hover:text-zinc-700 dark:hover:text-zinc-300"
        >
          Eval cookbook →
        </a>
      </header>

      <Card>
        <div className="flex items-baseline justify-between">
          <h2 className="font-medium">Trailing {trailing.windowDays}-day pass-rate</h2>
          <Chip kind={passRateChipKind(trailing.passRate)}>
            {fmtPct(trailing.passRate)}
          </Chip>
        </div>
        <p className="mt-1 text-sm text-zinc-500">
          Aggregate across {trailing.runCount} run{trailing.runCount === 1 ? '' : 's'} in the
          window. Per-run trend below — leftmost is oldest.
        </p>
        {trailing.perRun.length > 0 && (
          <div className="mt-3 flex h-12 items-end gap-1">
            {trailing.perRun.map((r, i) => {
              const h = r.passRate == null ? 0 : Math.max(4, r.passRate * 48);
              const color =
                r.passRate == null
                  ? 'bg-zinc-300 dark:bg-zinc-700'
                  : r.passRate >= 0.95
                    ? 'bg-emerald-500'
                    : r.passRate >= 0.8
                      ? 'bg-amber-500'
                      : 'bg-rose-500';
              return (
                <div
                  key={i}
                  className={`flex-1 rounded-t ${color}`}
                  style={{ height: `${h}px` }}
                  title={`${new Date(r.startedAt).toLocaleString()}: ${fmtPct(r.passRate)}`}
                />
              );
            })}
          </div>
        )}
      </Card>

      <section>
        <h2 className="mb-2 text-sm font-medium uppercase tracking-wide text-zinc-500">
          Recent runs
        </h2>
        {data.items.length === 0 ? (
          <Card>
            <p className="text-sm text-zinc-500">
              No eval runs yet. Trigger one with{' '}
              <code>pnpm --filter @mergecrew/eval-runner run -- --org {slug}</code>.
            </p>
          </Card>
        ) : (
          <Card className="p-0">
            <ul className="divide-y divide-zinc-200 dark:divide-zinc-800">
              {data.items.map((r) => {
                const rate =
                  r.totalCases > 0 ? r.passCount / r.totalCases : null;
                return (
                  <li key={r.id}>
                    <Link
                      href={`/orgs/${slug}/evals/${r.id}`}
                      className="flex items-center justify-between gap-3 px-4 py-3 text-sm hover:bg-zinc-50 dark:hover:bg-zinc-900"
                    >
                      <div className="flex min-w-0 flex-1 items-center gap-3">
                        <Chip kind={passRateChipKind(rate)}>{fmtPct(rate)}</Chip>
                        <div className="min-w-0">
                          <div className="font-mono text-xs text-zinc-500">
                            {r.id.slice(0, 8)} · {r.source}
                          </div>
                          <div className="truncate text-xs text-zinc-500">
                            {r.passCount} pass · {r.failCount} fail · {r.errorCount} error
                          </div>
                        </div>
                      </div>
                      <div className="shrink-0 text-right text-xs text-zinc-500">
                        <div>${r.totalUsd.toFixed(2)} · {(r.totalLatencyMs / 1000).toFixed(1)}s</div>
                        <div>{relativeTime(r.startedAt)}</div>
                      </div>
                    </Link>
                  </li>
                );
              })}
            </ul>
          </Card>
        )}
      </section>
    </main>
  );
}
