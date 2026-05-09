import { api } from '@/lib/api';
import { requireSession } from '@/lib/session';
import { Card } from '@/components/ui';

interface CostRow {
  day: string;
  usd: number;
  tokens: number;
  provider_kind: string;
  model_id: string;
}

interface CostsResponse {
  days: number;
  items: CostRow[];
}

const DAY_OPTIONS = [7, 30, 90];

export default async function CostsPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ days?: string }>;
}) {
  const { slug } = await params;
  const sp = await searchParams;
  const session = await requireSession();
  const days = clampDays(sp.days);
  const costs = await api<CostsResponse>(`/v1/orgs/${slug}/costs?days=${days}`, { session });

  const total = sumUsd(costs.items);
  const totalTokens = sumTokens(costs.items);
  const distinctDays = new Set(costs.items.map((r) => normalizeDay(r.day))).size || 1;
  const avgPerDay = total / distinctDays;
  const byDay = groupByDay(costs.items);
  const byProvider = groupBy(costs.items, (r) => r.provider_kind);
  const byModel = groupBy(costs.items, (r) => r.model_id);
  const topModel = byModel.items[0];
  const maxDayUsd = Math.max(0, ...byDay.items.map((d) => d.usd));

  return (
    <main className="mx-auto max-w-5xl space-y-6 p-6">
      <header className="flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Costs</h1>
          <p className="text-sm text-zinc-500">
            LLM spend across this organization. {distinctDays} day{distinctDays === 1 ? '' : 's'} of activity in the window.
          </p>
        </div>
        <DaysToggle slug={slug} current={days} />
      </header>

      <section className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Tile label="Total" value={formatUsd(total)} sub={`Last ${costs.days}d`} />
        <Tile label="Tokens" value={formatNumber(totalTokens)} sub="Input + output" />
        <Tile label="Daily avg" value={formatUsd(avgPerDay)} sub={`Across ${distinctDays} active days`} />
        <Tile
          label="Top model"
          value={topModel ? formatUsd(topModel.usd) : '—'}
          sub={topModel?.key ?? 'No spend yet'}
          mono
        />
      </section>

      {byDay.items.length > 0 && (
        <section>
          <h2 className="mb-3 text-sm font-medium uppercase tracking-wide text-zinc-500">
            Spend by day
          </h2>
          <Card>
            <ul className="space-y-1.5">
              {byDay.items.map((d) => (
                <li key={d.day} className="flex items-center gap-3 text-sm">
                  <span className="w-24 shrink-0 text-zinc-500">
                    {new Date(d.day).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                  </span>
                  <span className="h-2 flex-1 rounded bg-zinc-100 dark:bg-zinc-800">
                    <span
                      className="block h-full rounded bg-accent"
                      style={{ width: `${maxDayUsd > 0 ? (d.usd / maxDayUsd) * 100 : 0}%` }}
                    />
                  </span>
                  <span className="w-20 shrink-0 text-right font-mono tabular-nums">
                    {formatUsd(d.usd)}
                  </span>
                </li>
              ))}
            </ul>
          </Card>
        </section>
      )}

      <section className="grid grid-cols-1 gap-6 md:grid-cols-2">
        <BreakdownCard title="By provider" rows={byProvider.items} mono={false} />
        <BreakdownCard title="By model" rows={byModel.items} mono />
      </section>

      <section>
        <h2 className="mb-3 text-sm font-medium uppercase tracking-wide text-zinc-500">
          Detail
        </h2>
        <Card className="overflow-x-auto p-0">
          {costs.items.length === 0 ? (
            <div className="p-4 text-sm text-zinc-500">No spend recorded in this window.</div>
          ) : (
            <table className="w-full text-sm">
              <thead className="text-left text-xs uppercase tracking-wide text-zinc-500">
                <tr className="border-b dark:border-zinc-800">
                  <th className="px-4 py-2 font-medium">Day</th>
                  <th className="px-4 py-2 font-medium">Provider</th>
                  <th className="px-4 py-2 font-medium">Model</th>
                  <th className="px-4 py-2 text-right font-medium">Tokens</th>
                  <th className="px-4 py-2 text-right font-medium">USD</th>
                </tr>
              </thead>
              <tbody>
                {costs.items.map((r, i) => (
                  <tr key={i} className="border-b last:border-b-0 dark:border-zinc-800">
                    <td className="px-4 py-2">{new Date(r.day).toLocaleDateString()}</td>
                    <td className="px-4 py-2">{r.provider_kind}</td>
                    <td className="px-4 py-2 font-mono text-xs">{r.model_id}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{formatNumber(r.tokens)}</td>
                    <td className="px-4 py-2 text-right font-mono tabular-nums">${Number(r.usd).toFixed(4)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      </section>
    </main>
  );
}

function Tile({ label, value, sub, mono }: { label: string; value: string; sub: string; mono?: boolean }) {
  return (
    <Card>
      <div className="text-xs uppercase tracking-wide text-zinc-500">{label}</div>
      <div className={`mt-1 text-2xl font-semibold ${mono ? 'truncate font-mono text-base' : ''}`}>
        {value}
      </div>
      <div className="mt-0.5 truncate text-xs text-zinc-500">{sub}</div>
    </Card>
  );
}

function BreakdownCard({
  title,
  rows,
  mono,
}: {
  title: string;
  rows: { key: string; usd: number; tokens: number }[];
  mono: boolean;
}) {
  const max = Math.max(0, ...rows.map((r) => r.usd));
  return (
    <div>
      <h2 className="mb-3 text-sm font-medium uppercase tracking-wide text-zinc-500">{title}</h2>
      <Card>
        {rows.length === 0 ? (
          <p className="text-sm text-zinc-500">No data.</p>
        ) : (
          <ul className="space-y-2">
            {rows.map((r) => (
              <li key={r.key} className="text-sm">
                <div className="flex items-baseline justify-between gap-3">
                  <span className={mono ? 'truncate font-mono text-xs' : 'truncate'}>{r.key}</span>
                  <span className="shrink-0 font-mono tabular-nums">{formatUsd(r.usd)}</span>
                </div>
                <div className="mt-1 h-1.5 rounded bg-zinc-100 dark:bg-zinc-800">
                  <div
                    className="h-full rounded bg-accent"
                    style={{ width: `${max > 0 ? (r.usd / max) * 100 : 0}%` }}
                  />
                </div>
                <div className="mt-0.5 text-[11px] text-zinc-500">
                  {formatNumber(r.tokens)} tokens
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

function DaysToggle({ slug, current }: { slug: string; current: number }) {
  return (
    <div className="flex gap-1 rounded-md border bg-zinc-50 p-0.5 text-xs dark:bg-zinc-900 dark:border-zinc-800">
      {DAY_OPTIONS.map((d) => (
        <a
          key={d}
          href={`/orgs/${slug}/costs?days=${d}`}
          className={
            'rounded px-2 py-1 ' +
            (d === current
              ? 'bg-zinc-900 text-zinc-50 dark:bg-zinc-100 dark:text-zinc-900'
              : 'text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800')
          }
        >
          {d}d
        </a>
      ))}
    </div>
  );
}

function clampDays(raw?: string): number {
  const parsed = Number(raw);
  if (DAY_OPTIONS.includes(parsed)) return parsed;
  return 30;
}

function sumUsd(rows: CostRow[]): number {
  return rows.reduce((s, r) => s + Number(r.usd ?? 0), 0);
}

function sumTokens(rows: CostRow[]): number {
  return rows.reduce((s, r) => s + Number(r.tokens ?? 0), 0);
}

function normalizeDay(d: string): string {
  return new Date(d).toISOString().slice(0, 10);
}

function groupByDay(rows: CostRow[]) {
  const map = new Map<string, { day: string; usd: number; tokens: number }>();
  for (const r of rows) {
    const day = normalizeDay(r.day);
    const cur = map.get(day) ?? { day, usd: 0, tokens: 0 };
    cur.usd += Number(r.usd ?? 0);
    cur.tokens += Number(r.tokens ?? 0);
    map.set(day, cur);
  }
  const items = Array.from(map.values()).sort((a, b) => a.day.localeCompare(b.day));
  return { items };
}

function groupBy(rows: CostRow[], keyFn: (r: CostRow) => string) {
  const map = new Map<string, { key: string; usd: number; tokens: number }>();
  for (const r of rows) {
    const key = keyFn(r);
    const cur = map.get(key) ?? { key, usd: 0, tokens: 0 };
    cur.usd += Number(r.usd ?? 0);
    cur.tokens += Number(r.tokens ?? 0);
    map.set(key, cur);
  }
  const items = Array.from(map.values()).sort((a, b) => b.usd - a.usd);
  return { items };
}

function formatUsd(n: number): string {
  if (n === 0) return '$0.00';
  if (n < 0.01) return `$${n.toFixed(4)}`;
  if (n < 1) return `$${n.toFixed(3)}`;
  return `$${n.toFixed(2)}`;
}

function formatNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}
