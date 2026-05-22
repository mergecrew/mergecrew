import Link from 'next/link';
import { apiOr404 } from '@/lib/api';
import { requireSession } from '@/lib/session';
import { Card, PageHead, Tile } from '@/components/ui';
import { relativeTime } from '@/lib/format';

type ChangesetRow = {
  id: string;
  title?: string | null;
  status: string;
  updatedAt: string;
  prUrl?: string | null;
  prNumber?: number | null;
  additions?: number | null;
  deletions?: number | null;
  filesChanged?: number | null;
};

const STATUS_TONES: Record<string, string> = {
  promoted: 'bg-positive text-white',
  merged: 'bg-positive text-white',
  approved: 'bg-positive-soft text-positive-deep border border-positive',
  ready: 'bg-accent text-white',
  open: 'bg-accent text-white',
  awaiting_review: 'bg-energy text-white',
  review: 'bg-energy text-white',
  deferred: 'bg-bg text-ink-2 border border-hair-strong',
  blocked: 'bg-energy-soft text-energy-deep border border-energy',
  rejected: 'bg-energy-soft text-energy-deep border border-energy',
  failed: 'bg-energy-soft text-energy-deep border border-energy',
  draft: 'bg-bg text-muted border border-hair',
  closed: 'bg-ink text-paper',
  rolledback: 'bg-ink text-paper',
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

export default async function ChangesetsPage({
  params,
}: {
  params: Promise<{ slug: string; projectSlug: string }>;
}) {
  const { slug, projectSlug } = await params;
  const session = await requireSession();
  const list = await apiOr404<{ items: ChangesetRow[] }>(
    `/v1/orgs/${slug}/projects/${projectSlug}/changesets`,
    { session },
  );
  const items = list.items ?? [];

  const counts = items.reduce(
    (acc, c) => {
      acc.total += 1;
      if (['promoted', 'merged'].includes(c.status)) acc.promoted += 1;
      if (['review', 'awaiting_review', 'blocked', 'rejected'].includes(c.status)) acc.review += 1;
      if (['ready', 'open'].includes(c.status)) acc.ready += 1;
      return acc;
    },
    { total: 0, promoted: 0, review: 0, ready: 0 },
  );

  return (
    <main className="mx-auto max-w-[1280px] px-4 py-5 sm:px-9 sm:py-7">
      <PageHead
        crumb={[
          { label: slug, href: `/orgs/${slug}` },
          { label: projectSlug, href: `/orgs/${slug}/projects/${projectSlug}` },
          { label: 'Changesets' },
        ]}
        title="Changesets"
      />

      <section className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-4">
        <Tile k="Total" v={String(counts.total)} />
        <Tile k="Ready" v={String(counts.ready)} accent />
        <Tile k="Awaiting review" v={String(counts.review)} energy />
        <Tile k="Promoted" v={String(counts.promoted)} positive />
      </section>

      <Card>
        {items.length === 0 ? (
          <div className="p-5 text-[13px] text-muted">No changesets yet.</div>
        ) : (
          <ul className="m-0 list-none p-0">
            {items.map((cs, i) => (
              <li
                key={cs.id}
                className={i < items.length - 1 ? 'border-b border-hair-2' : ''}
              >
                <Link
                  href={`/orgs/${slug}/projects/${projectSlug}/changesets/${cs.id}`}
                  className="grid grid-cols-[80px_1fr_auto_auto] items-center gap-4 px-5 py-4 text-ink no-underline hover:bg-paper-2"
                >
                  <div className="font-mono text-[12.5px] text-ink-2">
                    {cs.prNumber ? `#${cs.prNumber}` : cs.id.slice(0, 8)}
                  </div>
                  <div className="min-w-0">
                    <div className="truncate text-[14px] font-medium tracking-[-0.005em]">
                      {cs.title ?? cs.id.slice(0, 8)}
                    </div>
                    <div className="mt-[2px] font-mono text-[11.5px] text-muted">
                      updated {relativeTime(cs.updatedAt)}
                    </div>
                  </div>
                  <div className="font-mono text-[12px] text-ink-2 whitespace-nowrap">
                    {cs.additions != null && cs.deletions != null ? (
                      <>
                        <span className="text-positive-deep">+{cs.additions}</span>{' '}
                        <span className="text-energy-deep">-{cs.deletions}</span>
                      </>
                    ) : (
                      <span className="text-muted-2">—</span>
                    )}
                  </div>
                  <StatusPill status={cs.status} />
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </main>
  );
}
