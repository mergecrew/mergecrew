import { api } from '@/lib/api';
import { requireSession } from '@/lib/session';
import { Card, PageHead, Tile as UiTile } from '@/components/ui';

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
    <main className="mx-auto max-w-[1280px] px-4 py-5 sm:px-9 sm:py-7">
      <PageHead
        crumb={[
          { label: slug, href: `/orgs/${slug}` },
          { label: 'Costs' },
        ]}
        title="Costs"
        meta={
          <span className="font-mono text-[12.5px] text-muted">
            LLM spend across this org · {distinctDays} day
            {distinctDays === 1 ? '' : 's'} in window
          </span>
        }
        actions={<DaysToggle slug={slug} current={days} />}
      />

      <section className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-4">
        <UiTile k="Total" v={formatUsd(total)} n={`Last ${costs.days}d`} />
        <UiTile k="Tokens" v={formatNumber(totalTokens)} n="Input + output" />
        <UiTile k="Daily avg" v={formatUsd(avgPerDay)} n={`${distinctDays} active days`} />
        <UiTile
          k="Top model"
          v={topModel ? formatUsd(topModel.usd) : '—'}
          n={topModel?.key ?? 'No spend yet'}
          accent
        />
      </section>

      {byDay.items.length > 0 && (
        <section className="mb-6">
          <div className="mb-3 font-mono text-[11px] uppercase tracking-[0.1em] text-muted">
            Spend by day
          </div>
          <Card className="p-5">
            <ul className="m-0 space-y-2 list-none p-0">
              {byDay.items.map((d) => (
                <li key={d.day} className="flex items-center gap-3 text-[13px]">
                  <span className="w-24 shrink-0 font-mono text-[11.5px] text-muted">
                    {new Date(d.day).toLocaleDateString(undefined, {
                      month: 'short',
                      day: 'numeric',
                    })}
                  </span>
                  <span className="h-2 flex-1 bg-bg-2">
                    <span
                      className="block h-full bg-accent"
                      style={{ width: `${maxDayUsd > 0 ? (d.usd / maxDayUsd) * 100 : 0}%` }}
                    />
                  </span>
                  <span className="w-20 shrink-0 text-right font-mono tabular-nums text-ink">
                    {formatUsd(d.usd)}
                  </span>
                </li>
              ))}
            </ul>
          </Card>
        </section>
      )}

      <section className="mb-6 grid grid-cols-1 gap-6 md:grid-cols-2">
        <BreakdownCard title="By provider" rows={byProvider.items} mono={false} />
        <BreakdownCard title="By model" rows={byModel.items} mono />
      </section>

      <section>
        <div className="mb-3 font-mono text-[11px] uppercase tracking-[0.1em] text-muted">
          Detail
        </div>
        <Card>
          {costs.items.length === 0 ? (
            <div className="p-4 text-[13px] text-muted">No spend recorded in this window.</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-[13px]">
                <thead className="text-left font-mono text-[10.5px] uppercase tracking-[0.06em] text-muted">
                  <tr className="border-b border-ink">
                    <th className="px-4 py-2 font-medium">Day</th>
                    <th className="px-4 py-2 font-medium">Provider</th>
                    <th className="px-4 py-2 font-medium">Model</th>
                    <th className="px-4 py-2 text-right font-medium">Tokens</th>
                    <th className="px-4 py-2 text-right font-medium">USD</th>
                  </tr>
                </thead>
                <tbody>
                  {costs.items.map((r, i) => (
                    <tr key={i} className="border-b border-hair-2 last:border-b-0">
                      <td className="px-4 py-2 font-mono text-[11.5px] text-ink-2">
                        {new Date(r.day).toLocaleDateString()}
                      </td>
                      <td className="px-4 py-2">{r.provider_kind}</td>
                      <td className="px-4 py-2 font-mono text-[11.5px] text-ink-2">
                        {r.model_id}
                      </td>
                      <td className="px-4 py-2 text-right tabular-nums">
                        {formatNumber(r.tokens)}
                      </td>
                      <td className="px-4 py-2 text-right font-mono tabular-nums">
                        ${Number(r.usd).toFixed(4)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </section>
    </main>
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
      <div className="mb-3 font-mono text-[11px] uppercase tracking-[0.1em] text-muted">
        {title}
      </div>
      <Card className="p-5">
        {rows.length === 0 ? (
          <p className="m-0 text-[13px] text-muted">No data.</p>
        ) : (
          <ul className="m-0 space-y-3 list-none p-0">
            {rows.map((r) => (
              <li key={r.key} className="text-[13px]">
                <div className="flex items-baseline justify-between gap-3">
                  <span className={mono ? 'truncate font-mono text-[12px] text-ink' : 'truncate'}>
                    {r.key}
                  </span>
                  <span className="shrink-0 font-mono tabular-nums text-ink">
                    {formatUsd(r.usd)}
                  </span>
                </div>
                <div className="mt-1 h-1.5 bg-bg-2">
                  <div
                    className="h-full bg-accent"
                    style={{ width: `${max > 0 ? (r.usd / max) * 100 : 0}%` }}
                  />
                </div>
                <div className="mt-1 font-mono text-[11px] text-muted">
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
    <div className="flex gap-1 border border-hair bg-paper p-[2px] font-mono text-[11px]">
      {DAY_OPTIONS.map((d) => (
        <a
          key={d}
          href={`/orgs/${slug}/costs?days=${d}`}
          className={
            'px-[10px] py-[4px] no-underline ' +
            (d === current
              ? 'bg-ink text-paper'
              : 'text-ink-2 hover:bg-bg')
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
