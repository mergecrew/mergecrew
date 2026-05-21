import Link from 'next/link';
import { api } from '@/lib/api';
import { requireSession } from '@/lib/session';
import { Card, PageHead, Tile, LinkButton } from '@/components/ui';
import { relativeTime } from '@/lib/format';

type Run = {
  id: string;
  status: string;
  scheduledAt: string;
  startedAt?: string | null;
  finishedAt?: string | null;
  totalUsdEstimate?: number | null;
  branch?: string | null;
  trigger?: string | null;
  prCount?: number | null;
  deferredCount?: number | null;
  regressionCount?: number | null;
};

const STATUS_TONES: Record<string, string> = {
  done: 'bg-positive text-white',
  completed: 'bg-positive text-white',
  running: 'bg-accent text-white animate-step-pulse',
  failed: 'bg-energy-soft text-energy-deep border border-energy',
  cancelled: 'bg-bg text-ink-2 border border-hair-strong',
  skipped: 'bg-bg text-muted border border-hair',
  scheduled: 'bg-bg text-ink-2 border border-hair',
};

function StatusPill({ status }: { status: string }) {
  const cls = STATUS_TONES[status] ?? 'bg-bg text-ink-2 border border-hair';
  return (
    <span
      className={`px-[10px] py-[3px] font-mono text-[10.5px] uppercase tracking-[0.06em] ${cls}`}
    >
      {status}
    </span>
  );
}

function fmtDurationMs(startISO: string | null | undefined, endISO: string | null | undefined) {
  if (!startISO || !endISO) return '—';
  const ms = new Date(endISO).getTime() - new Date(startISO).getTime();
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return rem ? `${m}m ${rem}s` : `${m}m`;
}

export default async function RunsListPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string; projectSlug: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { slug, projectSlug } = await params;
  const sp = (await searchParams) ?? {};
  const status = typeof sp.status === 'string' ? sp.status : null;
  const session = await requireSession();
  const query = new URLSearchParams({ limit: '50' });
  if (status) query.set('status', status);
  const list = await api<{ items: Run[]; total?: number }>(
    `/v1/orgs/${slug}/projects/${projectSlug}/runs?${query.toString()}`,
    { session },
  ).catch(() => ({ items: [] as Run[], total: 0 } as { items: Run[]; total?: number }));

  const items = list.items ?? [];
  const totalRuns = list.total ?? items.length;
  const completed = items.filter((r) => r.status === 'done' || r.status === 'completed').length;
  const failed = items.filter((r) => r.status === 'failed').length;
  const totalCost = items.reduce(
    (sum, r) => sum + (typeof r.totalUsdEstimate === 'number' ? r.totalUsdEstimate : 0),
    0,
  );

  return (
    <main className="mx-auto max-w-[1280px] px-9 py-7">
      <PageHead
        crumb={[
          { label: slug, href: `/orgs/${slug}` },
          { label: projectSlug, href: `/orgs/${slug}/projects/${projectSlug}` },
          { label: 'Runs' },
        ]}
        title="Runs"
        meta={
          <span className="font-mono text-[12.5px] text-muted">
            most recent {items.length} of {totalRuns}
          </span>
        }
      />

      <section className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-4">
        <Tile k="Window" v={String(items.length)} n="runs shown" />
        <Tile k="Completed" v={String(completed)} positive />
        <Tile k="Failed" v={String(failed)} energy={failed > 0} />
        <Tile k="Spent" v={`$${totalCost.toFixed(2)}`} accent />
      </section>

      <section className="mb-3 flex flex-wrap items-center gap-2 font-mono text-[11.5px] uppercase tracking-[0.06em] text-muted">
        <span className="text-ink-2">Status</span>
        {[null, 'done', 'failed', 'cancelled', 'running'].map((s) => {
          const href =
            s === null
              ? `/orgs/${slug}/projects/${projectSlug}/runs`
              : `/orgs/${slug}/projects/${projectSlug}/runs?status=${s}`;
          const active = status === s || (status === null && s === null);
          return (
            <Link
              key={String(s)}
              href={href}
              className={`border px-[10px] py-[3px] no-underline ${
                active
                  ? 'border-accent bg-accent-tint text-accent-deep'
                  : 'border-hair text-ink-2 hover:bg-paper-2'
              }`}
            >
              {s ?? 'all'}
            </Link>
          );
        })}
      </section>

      <Card>
        {items.length === 0 ? (
          <div className="p-5 text-[13px] text-muted">
            No runs match this filter. Trigger one from the project header to see runs here.
          </div>
        ) : (
          <ul className="m-0 list-none p-0">
            <li className="hidden border-b border-ink px-5 py-2 font-mono text-[10.5px] uppercase tracking-[0.06em] text-muted md:grid md:grid-cols-[100px_1fr_110px_90px_90px_120px] md:gap-4">
              <span>Run</span>
              <span>Started</span>
              <span>Status</span>
              <span>Runtime</span>
              <span>Cost</span>
              <span>Trigger</span>
            </li>
            {items.map((r, i) => (
              <li
                key={r.id}
                className={i < items.length - 1 ? 'border-b border-hair-2' : ''}
              >
                <Link
                  href={`/orgs/${slug}/projects/${projectSlug}/runs/${r.id}`}
                  className="grid grid-cols-1 items-center gap-2 px-5 py-4 text-[13px] text-ink no-underline hover:bg-paper-2 md:grid-cols-[100px_1fr_110px_90px_90px_120px] md:gap-4"
                >
                  <span className="font-mono text-[12px] text-ink-2">
                    {r.id.slice(0, 8)}
                  </span>
                  <div className="min-w-0">
                    <div className="font-medium tracking-[-0.005em]">
                      {relativeTime(r.startedAt ?? r.scheduledAt)}
                    </div>
                    {r.branch && (
                      <div className="mt-[2px] truncate font-mono text-[11.5px] text-muted">
                        {r.branch}
                      </div>
                    )}
                  </div>
                  <StatusPill status={r.status} />
                  <span className="font-mono text-[12px] text-ink-2">
                    {fmtDurationMs(r.startedAt, r.finishedAt)}
                  </span>
                  <span className="font-mono text-[12px] text-ink">
                    {typeof r.totalUsdEstimate === 'number'
                      ? `$${r.totalUsdEstimate.toFixed(2)}`
                      : '—'}
                  </span>
                  <span className="font-mono text-[11.5px] text-muted">
                    {r.trigger ?? 'scheduled'}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <div className="mt-6 text-[12.5px] text-muted">
        Need a live run?{' '}
        <LinkButton
          href={`/orgs/${slug}/projects/${projectSlug}/timeline`}
          variant="ghost"
          size="sm"
        >
          Jump to latest →
        </LinkButton>
      </div>
    </main>
  );
}
