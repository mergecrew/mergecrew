import Link from 'next/link';
import { api } from '@/lib/api';
import { requireSession } from '@/lib/session';
import { Card, Button, PageHead, Label } from '@/components/ui';
import { relativeTime } from '@/lib/format';

interface InboxItem {
  id: string;
  reason: string;
  details: Record<string, any>;
  changesetId: string | null;
  projectId: string;
  projectSlug: string | null;
  createdAt: string;
}

function severityFromReason(reason: string): 'high' | 'med' | 'low' {
  if (reason === 'risk_score_high' || reason === 'blast_radius') return 'high';
  if (reason === 'review_required') return 'med';
  return 'low';
}

function severityGlyph(reason: string) {
  if (reason === 'risk_score_high') return 'R';
  if (reason === 'blast_radius') return 'B';
  if (reason === 'review_required') return 'V';
  return reason.slice(0, 1).toUpperCase();
}

const SEVERITY_TONES: Record<'high' | 'med' | 'low', string> = {
  high: 'bg-energy border-energy text-paper',
  med: 'bg-warn border-warn text-ink',
  low: 'bg-accent-soft border-accent text-accent-deep',
};

export default async function InboxPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const session = await requireSession();
  const inbox = await api<{ items: InboxItem[] }>(`/v1/orgs/${slug}/inbox`, { session });
  const items = inbox.items ?? [];

  const counts = items.reduce(
    (acc, a) => {
      const s = severityFromReason(a.reason);
      acc[s] += 1;
      return acc;
    },
    { high: 0, med: 0, low: 0 },
  );

  return (
    <main className="mx-auto max-w-[1280px] px-4 py-5 sm:px-9 sm:py-7">
      <PageHead
        crumb={[
          { label: slug, href: `/orgs/${slug}` },
          { label: 'Inbox' },
        ]}
        title="Inbox"
        meta={
          <span className="font-mono text-[12.5px] text-muted">
            {items.length} pending · anything that trips a guardrail lands here
          </span>
        }
      />

      <section className="mb-6 grid grid-cols-3 gap-3">
        <div className="border border-hair bg-paper px-[18px] py-[14px]">
          <Label energy>High</Label>
          <div className="mt-1 text-[26px] font-medium text-energy-deep leading-none">
            {counts.high}
          </div>
        </div>
        <div className="border border-hair bg-paper px-[18px] py-[14px]">
          <Label>Medium</Label>
          <div className="mt-1 text-[26px] font-medium leading-none">{counts.med}</div>
        </div>
        <div className="border border-hair bg-paper px-[18px] py-[14px]">
          <Label accent>Low</Label>
          <div className="mt-1 text-[26px] font-medium text-accent-deep leading-none">
            {counts.low}
          </div>
        </div>
      </section>

      {items.length === 0 ? (
        <Card className="p-5">
          <p className="m-0 text-[13.5px] text-muted">
            Nothing pending — quiet day. Anything that trips a guardrail (risk score · blast
            radius · denied path · budget · missing reviewer) lands here.
          </p>
        </Card>
      ) : (
        <ul className="m-0 space-y-3 list-none p-0">
          {items.map((a) => {
            const sev = severityFromReason(a.reason);
            return (
              <li key={a.id}>
                <Card>
                  <div className="grid grid-cols-[56px_1fr_auto] gap-4 px-5 py-5">
                    <div
                      className={`flex h-[44px] w-[44px] items-center justify-center border-[1.5px] font-mono text-[20px] font-semibold ${SEVERITY_TONES[sev]}`}
                    >
                      {severityGlyph(a.reason)}
                    </div>
                    <div className="min-w-0">
                      {a.reason === 'risk_score_high' ? (
                        <RiskScoreItem item={a} slug={slug} />
                      ) : (
                        <GenericItem item={a} />
                      )}
                      <div className="mt-3 font-mono text-[11.5px] text-muted">
                        {a.projectSlug ? `${a.projectSlug} · ` : ''}filed{' '}
                        {relativeTime(a.createdAt)}
                      </div>
                    </div>
                    <ResolveForm
                      slug={slug}
                      projectSlug={a.projectSlug ?? '-'}
                      approvalId={a.id}
                      changesetHref={
                        a.changesetId && a.projectSlug
                          ? `/orgs/${slug}/projects/${a.projectSlug}/changesets/${a.changesetId}`
                          : null
                      }
                    />
                  </div>
                </Card>
              </li>
            );
          })}
        </ul>
      )}
    </main>
  );
}

function GenericItem({ item }: { item: InboxItem }) {
  return (
    <div>
      <div className="text-[14px] font-medium tracking-[-0.005em]">{item.reason}</div>
      <pre className="mt-2 m-0 max-h-[140px] overflow-auto border-l-[3px] border-hair bg-bg-2 p-2 font-mono text-[11.5px] leading-[1.5] text-ink-2 whitespace-pre-wrap">
        {JSON.stringify(item.details, null, 2)}
      </pre>
    </div>
  );
}

function RiskScoreItem({ item, slug }: { item: InboxItem; slug: string }) {
  const { score, threshold, filesChanged, linesChanged, sensitiveHits, prNumber, prUrl } =
    item.details ?? {};
  const hits = Array.isArray(sensitiveHits) ? sensitiveHits : [];
  return (
    <div>
      <div className="flex flex-wrap items-baseline gap-2">
        <span className="text-[14px] font-medium tracking-[-0.005em]">
          Changeset needs review · risk score
        </span>
        <span className="bg-energy-soft px-[8px] py-[2px] font-mono text-[10.5px] text-energy-deep">
          {Number(score ?? 0).toFixed(1)} &gt; {Number(threshold ?? 0).toFixed(0)}
        </span>
      </div>
      <p className="mt-1 text-[12.5px] text-ink-2">
        Score breakdown:{' '}
        <span className="font-mono">
          {Number(filesChanged ?? 0)} files × 1 + {Number(linesChanged ?? 0)} lines × 0.1 +{' '}
          {hits.length} sensitive × 10
        </span>
      </p>
      {hits.length > 0 && (
        <ul className="mt-2 m-0 space-y-1 list-none p-0">
          {hits.map((h: any, i: number) => (
            <li key={i} className="font-mono text-[11.5px] text-energy-deep">
              ⊘ <code>{h.path}</code> ← <code>{h.glob}</code>
            </li>
          ))}
        </ul>
      )}
      <div className="mt-2 flex flex-wrap gap-3 text-[12px]">
        {item.changesetId && item.projectSlug && (
          <Link
            href={`/orgs/${slug}/projects/${item.projectSlug}/changesets/${item.changesetId}`}
            className="text-accent underline-offset-[3px] hover:underline"
          >
            View changeset →
          </Link>
        )}
        {prUrl && (
          <a
            href={prUrl}
            target="_blank"
            rel="noreferrer"
            className="text-accent underline-offset-[3px] hover:underline"
          >
            PR #{prNumber} →
          </a>
        )}
      </div>
    </div>
  );
}

async function resolveAction(formData: FormData) {
  'use server';
  const slug = String(formData.get('slug') ?? '');
  const projectSlug = String(formData.get('projectSlug') ?? '');
  const approvalId = String(formData.get('approvalId') ?? '');
  const resolution = String(formData.get('resolution') ?? 'approve');
  const session = await requireSession();
  await api(`/v1/orgs/${slug}/projects/${projectSlug}/approvals/${approvalId}/resolve`, {
    method: 'POST',
    body: JSON.stringify({ resolution }),
    session,
  });
}

function ResolveForm({
  slug,
  projectSlug,
  approvalId,
  changesetHref,
}: {
  slug: string;
  projectSlug: string;
  approvalId: string;
  changesetHref: string | null;
}) {
  return (
    <div className="flex shrink-0 flex-col gap-2">
      <form action={resolveAction}>
        <input type="hidden" name="slug" value={slug} />
        <input type="hidden" name="projectSlug" value={projectSlug} />
        <input type="hidden" name="approvalId" value={approvalId} />
        <input type="hidden" name="resolution" value="approve" />
        <Button variant="energy" size="sm" className="w-full">
          Approve
        </Button>
      </form>
      <form action={resolveAction}>
        <input type="hidden" name="slug" value={slug} />
        <input type="hidden" name="projectSlug" value={projectSlug} />
        <input type="hidden" name="approvalId" value={approvalId} />
        <input type="hidden" name="resolution" value="reject" />
        <Button variant="danger" size="sm" className="w-full">
          Reject
        </Button>
      </form>
      {changesetHref && (
        <Link
          href={changesetHref}
          className="border border-hair bg-paper px-[10px] py-[6px] text-center font-mono text-[11px] text-ink-2 no-underline hover:bg-paper-2"
        >
          Open changeset
        </Link>
      )}
    </div>
  );
}
