import Link from 'next/link';
import { api } from '@/lib/api';
import { requireSession } from '@/lib/session';
import { Card, Chip } from '@/components/ui';

interface EvalRun {
  id: string;
  totalCases: number;
  passCount: number;
  failCount: number;
  errorCount: number;
  totalUsd: number;
  totalLatencyMs: number;
}

interface EvalCase {
  fixtureId: string;
  status: string;
  usdEstimate: number;
  latencyMs: number;
  errorMessage: string | null;
}

interface CompareData {
  abRun: { id: string; startedAt: string; finishedAt: string | null };
  runA: EvalRun;
  runB: EvalRun;
  profileA: { id: string; name: string } | null;
  profileB: { id: string; name: string } | null;
  casesA: EvalCase[];
  casesB: EvalCase[];
}

function statusChip(status: string): { kind: 'low' | 'medium' | 'high' | 'neutral'; label: string } {
  if (status === 'pass') return { kind: 'low', label: 'pass' };
  if (status === 'fail') return { kind: 'medium', label: 'fail' };
  if (status === 'error') return { kind: 'high', label: 'error' };
  return { kind: 'neutral', label: status };
}

function delta(a: number, b: number, fmt: (n: number) => string): string {
  const d = b - a;
  if (d === 0) return '±0';
  const sign = d > 0 ? '+' : '−';
  return `${sign}${fmt(Math.abs(d))}`;
}

export default async function CompareEvalsPage({
  params,
}: {
  params: Promise<{ slug: string; abRunId: string }>;
}) {
  const { slug, abRunId } = await params;
  const session = await requireSession();
  const data = await api<CompareData>(`/v1/orgs/${slug}/evals/compare/${abRunId}`, { session });
  const { runA, runB, profileA, profileB, casesA, casesB } = data;

  // Merge cases by fixtureId so the table can render side-by-side.
  const byFixture = new Map<string, { a?: EvalCase; b?: EvalCase }>();
  for (const c of casesA) byFixture.set(c.fixtureId, { ...byFixture.get(c.fixtureId), a: c });
  for (const c of casesB) byFixture.set(c.fixtureId, { ...byFixture.get(c.fixtureId), b: c });
  const fixtureIds = Array.from(byFixture.keys()).sort();

  const passRateA = runA.totalCases > 0 ? runA.passCount / runA.totalCases : 0;
  const passRateB = runB.totalCases > 0 ? runB.passCount / runB.totalCases : 0;

  return (
    <main className="mx-auto max-w-4xl space-y-4 p-6">
      <Link
        href={`/orgs/${slug}/evals`}
        className="text-xs text-zinc-500 underline decoration-dotted hover:text-zinc-700 dark:hover:text-zinc-300"
      >
        ← Back to evals
      </Link>
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-xl font-semibold">A/B comparison</h1>
          <p className="text-sm text-zinc-500">
            {new Date(data.abRun.startedAt).toLocaleString()} ·{' '}
            <code>{profileA?.name ?? 'A'}</code> vs <code>{profileB?.name ?? 'B'}</code>
          </p>
        </div>
        <a
          href="https://github.com/mergecrew/mergecrew/blob/main/docs/03-infrastructure/15-evals.md#ab-compare"
          target="_blank"
          rel="noreferrer"
          className="text-xs text-zinc-500 underline decoration-dotted hover:text-zinc-700 dark:hover:text-zinc-300"
        >
          Eval cookbook →
        </a>
      </header>

      <Card>
        <div className="grid grid-cols-3 gap-3 text-sm">
          <div />
          <div className="font-medium">A · {profileA?.name ?? '—'}</div>
          <div className="font-medium">B · {profileB?.name ?? '—'}</div>

          <div className="text-xs uppercase tracking-wide text-zinc-500">Pass-rate</div>
          <div className="font-mono tabular-nums">{(passRateA * 100).toFixed(1)}%</div>
          <div className="font-mono tabular-nums">
            {(passRateB * 100).toFixed(1)}%{' '}
            <span className="text-xs text-zinc-500">
              ({delta(passRateA, passRateB, (n) => `${(n * 100).toFixed(1)}%`)})
            </span>
          </div>

          <div className="text-xs uppercase tracking-wide text-zinc-500">Cost</div>
          <div className="font-mono tabular-nums">${runA.totalUsd.toFixed(4)}</div>
          <div className="font-mono tabular-nums">
            ${runB.totalUsd.toFixed(4)}{' '}
            <span className="text-xs text-zinc-500">
              ({delta(runA.totalUsd, runB.totalUsd, (n) => `$${n.toFixed(4)}`)})
            </span>
          </div>

          <div className="text-xs uppercase tracking-wide text-zinc-500">Latency</div>
          <div className="font-mono tabular-nums">{(runA.totalLatencyMs / 1000).toFixed(1)}s</div>
          <div className="font-mono tabular-nums">
            {(runB.totalLatencyMs / 1000).toFixed(1)}s{' '}
            <span className="text-xs text-zinc-500">
              ({delta(runA.totalLatencyMs, runB.totalLatencyMs, (n) => `${(n / 1000).toFixed(1)}s`)})
            </span>
          </div>
        </div>
      </Card>

      <section>
        <h2 className="mb-2 text-sm font-medium uppercase tracking-wide text-zinc-500">
          Per-fixture
        </h2>
        <Card className="p-0">
          <table className="w-full text-sm">
            <thead className="border-b text-left text-xs uppercase tracking-wide text-zinc-500 dark:border-zinc-800">
              <tr>
                <th className="px-3 py-2 font-normal">Fixture</th>
                <th className="px-3 py-2 font-normal">A</th>
                <th className="px-3 py-2 font-normal">B</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-200 dark:divide-zinc-800">
              {fixtureIds.map((id) => {
                const { a, b } = byFixture.get(id)!;
                return (
                  <tr key={id}>
                    <td className="px-3 py-2 font-mono text-xs">{id}</td>
                    <td className="px-3 py-2">
                      <Cell row={a} />
                    </td>
                    <td className="px-3 py-2">
                      <Cell row={b} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Card>
      </section>

      <div className="text-xs text-zinc-500">
        Detail per run:{' '}
        <Link href={`/orgs/${slug}/evals/${runA.id}`} className="underline decoration-dotted">
          run A
        </Link>{' '}
        ·{' '}
        <Link href={`/orgs/${slug}/evals/${runB.id}`} className="underline decoration-dotted">
          run B
        </Link>
      </div>
    </main>
  );
}

function Cell({ row }: { row: EvalCase | undefined }) {
  if (!row) return <span className="text-xs text-zinc-400">—</span>;
  const chip = statusChip(row.status);
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Chip kind={chip.kind}>{chip.label}</Chip>
      <span className="font-mono text-xs text-zinc-500">
        ${row.usdEstimate.toFixed(4)} · {row.latencyMs}ms
      </span>
      {row.errorMessage && (
        <span
          className="text-xs text-rose-700 dark:text-rose-300 truncate max-w-[16rem]"
          title={row.errorMessage}
        >
          {row.errorMessage.slice(0, 60)}
          {row.errorMessage.length > 60 ? '…' : ''}
        </span>
      )}
    </div>
  );
}
