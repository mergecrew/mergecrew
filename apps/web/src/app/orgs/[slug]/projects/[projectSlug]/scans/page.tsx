import Link from 'next/link';
import { api } from '@/lib/api';
import { requireSession } from '@/lib/session';
import { Card, PageHead, Tile } from '@/components/ui';
import { relativeTime } from '@/lib/format';

type Severity = 'high' | 'medium' | 'low';

type ScanFinding = {
  id: string;
  title: string;
  type?: string | null;
  severity?: Severity | string | null;
  status?: string | null;
  scannedAt?: string | null;
  filedAt?: string | null;
  changesetId?: string | null;
};

const SEVERITY_TONES: Record<string, string> = {
  high: 'bg-energy text-paper border border-energy',
  medium: 'bg-warn/30 text-ink border border-warn',
  low: 'bg-accent-soft text-accent-deep border border-accent',
};

function SeverityPill({ severity }: { severity?: string | null }) {
  const v = (severity ?? 'low').toLowerCase();
  const cls = SEVERITY_TONES[v] ?? 'bg-bg text-ink-2 border border-hair';
  return (
    <span
      className={`px-[10px] py-[3px] font-mono text-[10.5px] uppercase tracking-[0.06em] ${cls}`}
    >
      {v}
    </span>
  );
}

export default async function ScansPage({
  params,
}: {
  params: Promise<{ slug: string; projectSlug: string }>;
}) {
  const { slug, projectSlug } = await params;
  const session = await requireSession();

  // Findings endpoint may not be enabled yet in older deployments.
  // Gracefully degrade to an empty state.
  const list = await api<{ items: ScanFinding[] }>(
    `/v1/orgs/${slug}/projects/${projectSlug}/findings?limit=50`,
    { session },
  ).catch(() => ({ items: [] as ScanFinding[] }));

  const items = list.items ?? [];
  const counts = items.reduce(
    (acc, f) => {
      const v = (f.severity ?? '').toLowerCase();
      if (v === 'high') acc.high += 1;
      else if (v === 'medium') acc.med += 1;
      else acc.low += 1;
      if (f.status === 'open' || f.status === 'pending') acc.open += 1;
      return acc;
    },
    { high: 0, med: 0, low: 0, open: 0 },
  );

  return (
    <main className="mx-auto max-w-[1280px] px-4 py-5 sm:px-9 sm:py-7">
      <PageHead
        crumb={[
          { label: slug, href: `/orgs/${slug}` },
          { label: projectSlug, href: `/orgs/${slug}/projects/${projectSlug}` },
          { label: 'Scan reports' },
        ]}
        title="Scan reports"
        meta={
          <span className="font-mono text-[12.5px] text-muted">
            Scanner output filed against this project — broken flows, console errors,
            regressions.
          </span>
        }
      />

      <section className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-4">
        <Tile k="High" v={String(counts.high)} energy={counts.high > 0} />
        <Tile k="Medium" v={String(counts.med)} />
        <Tile k="Low" v={String(counts.low)} />
        <Tile k="Open" v={String(counts.open)} accent={counts.open > 0} />
      </section>

      <Card>
        {items.length === 0 ? (
          <div className="p-5 text-[13px] text-muted">
            No findings yet. The Scanner files findings here when it exercises the dev preview
            and detects regressions — they then become tomorrow&apos;s tasks for the Planner.
          </div>
        ) : (
          <ul className="m-0 list-none p-0">
            <li className="hidden border-b border-ink px-5 py-2 font-mono text-[10.5px] uppercase tracking-[0.06em] text-muted md:grid md:grid-cols-[100px_1fr_120px_90px_90px] md:gap-4">
              <span>ID</span>
              <span>Finding</span>
              <span>Type</span>
              <span>Severity</span>
              <span>Status</span>
            </li>
            {items.map((f, i) => (
              <li
                key={f.id}
                className={i < items.length - 1 ? 'border-b border-hair-2' : ''}
              >
                <Link
                  href={
                    f.changesetId
                      ? `/orgs/${slug}/projects/${projectSlug}/changesets/${f.changesetId}`
                      : '#'
                  }
                  className="grid grid-cols-1 items-center gap-2 px-5 py-4 text-[13px] text-ink no-underline hover:bg-paper-2 md:grid-cols-[100px_1fr_120px_90px_90px] md:gap-4"
                >
                  <span className="font-mono text-[12px] text-ink-2">{f.id.slice(0, 8)}</span>
                  <div className="min-w-0">
                    <div className="truncate text-[13.5px] font-medium tracking-[-0.005em]">
                      {f.title}
                    </div>
                    <div className="mt-[2px] font-mono text-[11.5px] text-muted">
                      {relativeTime(f.scannedAt ?? f.filedAt ?? new Date().toISOString())}
                    </div>
                  </div>
                  <span className="font-mono text-[11.5px] text-muted">{f.type ?? '—'}</span>
                  <SeverityPill severity={f.severity} />
                  <span className="font-mono text-[11.5px] text-muted">
                    {f.status ?? 'open'}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </main>
  );
}
