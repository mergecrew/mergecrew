import Link from 'next/link';
import { api } from '@/lib/api';
import { requireSession } from '@/lib/session';
import { Card, Chip } from '@/components/ui';

interface EvalRun {
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

interface EvalCase {
  id: string;
  fixtureId: string;
  status: 'pass' | 'fail' | 'error' | string;
  agentDiff: string | null;
  errorMessage: string | null;
  usdEstimate: number;
  latencyMs: number;
}

function statusChip(status: string): { kind: 'low' | 'medium' | 'high' | 'neutral'; label: string } {
  if (status === 'pass') return { kind: 'low', label: 'pass' };
  if (status === 'fail') return { kind: 'medium', label: 'fail' };
  if (status === 'error') return { kind: 'high', label: 'error' };
  return { kind: 'neutral', label: status };
}

export default async function EvalDetailPage({
  params,
}: {
  params: Promise<{ slug: string; runId: string }>;
}) {
  const { slug, runId } = await params;
  const session = await requireSession();
  const data = await api<{ run: EvalRun; cases: EvalCase[] }>(
    `/v1/orgs/${slug}/evals/${runId}`,
    { session },
  );
  const { run, cases } = data;
  const passRate = run.totalCases > 0 ? run.passCount / run.totalCases : 0;

  return (
    <main className="mx-auto max-w-3xl space-y-4 p-6">
      <Link
        href={`/orgs/${slug}/evals`}
        className="text-xs text-zinc-500 underline decoration-dotted hover:text-zinc-700 dark:hover:text-zinc-300"
      >
        ← Back to evals
      </Link>
      <header className="flex items-baseline justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold font-mono">{run.id.slice(0, 8)}</h1>
          <p className="text-sm text-zinc-500">
            {new Date(run.startedAt).toLocaleString()} · source: {run.source}
          </p>
        </div>
        <Chip
          kind={passRate >= 0.95 ? 'low' : passRate >= 0.8 ? 'medium' : 'high'}
        >
          {(passRate * 100).toFixed(1)}%
        </Chip>
      </header>

      <Card>
        <div className="grid grid-cols-4 gap-3 text-sm">
          <Stat label="Pass" value={run.passCount} />
          <Stat label="Fail" value={run.failCount} />
          <Stat label="Error" value={run.errorCount} />
          <Stat label="Total" value={run.totalCases} />
          <Stat label="Cost" value={`$${run.totalUsd.toFixed(4)}`} />
          <Stat label="Latency" value={`${(run.totalLatencyMs / 1000).toFixed(1)}s`} />
        </div>
      </Card>

      <section>
        <h2 className="mb-2 text-sm font-medium uppercase tracking-wide text-zinc-500">
          Cases
        </h2>
        <Card className="p-0">
          <ul className="divide-y divide-zinc-200 dark:divide-zinc-800">
            {cases.map((c) => {
              const chip = statusChip(c.status);
              const shouldExpand = c.status !== 'pass';
              return (
                <li key={c.id} className="p-3">
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2 min-w-0">
                      <Chip kind={chip.kind}>{chip.label}</Chip>
                      <span className="font-mono text-sm">{c.fixtureId}</span>
                    </div>
                    <span className="shrink-0 text-xs text-zinc-500">
                      ${c.usdEstimate.toFixed(4)} · {c.latencyMs}ms
                    </span>
                  </div>
                  {c.errorMessage && (
                    <p className="mt-1 text-xs text-rose-700 dark:text-rose-300">
                      {c.errorMessage}
                    </p>
                  )}
                  {shouldExpand && c.agentDiff && (
                    <details className="mt-2">
                      <summary className="cursor-pointer text-xs uppercase tracking-wide text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300">
                        Agent diff ({c.agentDiff.length} chars)
                      </summary>
                      <pre className="mt-2 max-h-80 overflow-auto rounded bg-zinc-50 p-2 text-[11px] dark:bg-zinc-900">
                        {c.agentDiff}
                      </pre>
                    </details>
                  )}
                </li>
              );
            })}
          </ul>
        </Card>
      </section>
    </main>
  );
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div>
      <div className="text-xs uppercase tracking-wide text-zinc-500">{label}</div>
      <div className="font-mono tabular-nums">{value}</div>
    </div>
  );
}
