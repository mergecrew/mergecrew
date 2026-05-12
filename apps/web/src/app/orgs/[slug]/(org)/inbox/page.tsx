import Link from 'next/link';
import { api } from '@/lib/api';
import { requireSession } from '@/lib/session';
import { Card, Button } from '@/components/ui';

interface InboxItem {
  id: string;
  reason: string;
  details: Record<string, any>;
  changesetId: string | null;
  projectId: string;
  projectSlug: string | null;
  createdAt: string;
}

export default async function InboxPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const session = await requireSession();
  const inbox = await api<{ items: InboxItem[] }>(`/v1/orgs/${slug}/inbox`, { session });

  return (
    <main className="mx-auto max-w-3xl p-6 space-y-3">
      <h1 className="text-xl font-semibold">Inbox</h1>
      {inbox.items.length === 0 && (
        <Card>
          <p className="text-zinc-500">Nothing pending.</p>
        </Card>
      )}
      <ul className="space-y-2">
        {inbox.items.map((a) => (
          <li key={a.id}>
            <Card>
              <div className="flex items-start justify-between gap-2">
                <div className="flex-1 min-w-0">
                  {a.reason === 'risk_score_high' ? (
                    <RiskScoreItem item={a} slug={slug} />
                  ) : (
                    <GenericItem item={a} />
                  )}
                </div>
                <ResolveForm slug={slug} approvalId={a.id} />
              </div>
            </Card>
          </li>
        ))}
      </ul>
    </main>
  );
}

function GenericItem({ item }: { item: InboxItem }) {
  return (
    <div>
      <div className="font-medium">{item.reason}</div>
      <pre className="text-xs text-zinc-500 mt-1 whitespace-pre-wrap">
        {JSON.stringify(item.details, null, 2)}
      </pre>
    </div>
  );
}

function RiskScoreItem({ item, slug }: { item: InboxItem; slug: string }) {
  const {
    score,
    threshold,
    filesChanged,
    linesChanged,
    sensitiveHits,
    prNumber,
    prUrl,
  } = item.details ?? {};
  const hits = Array.isArray(sensitiveHits) ? sensitiveHits : [];
  return (
    <div>
      <div className="flex flex-wrap items-baseline gap-2">
        <span className="font-medium">Changeset needs review · risk score</span>
        <span className="rounded bg-amber-100 px-2 py-0.5 font-mono text-xs text-amber-900 dark:bg-amber-900/30 dark:text-amber-200">
          {Number(score ?? 0).toFixed(1)} &gt; {Number(threshold ?? 0).toFixed(0)}
        </span>
      </div>
      <p className="mt-1 text-xs text-zinc-500">
        Score breakdown:{' '}
        <span className="font-mono">
          {Number(filesChanged ?? 0)} files × 1
          {' + '}
          {Number(linesChanged ?? 0)} lines × 0.1
          {' + '}
          {hits.length} sensitive × 10
        </span>
      </p>
      {hits.length > 0 && (
        <ul className="mt-1 space-y-0.5 text-xs">
          {hits.map((h: any, i: number) => (
            <li key={i} className="font-mono text-zinc-600 dark:text-zinc-400">
              <code>{h.path}</code> ← <code>{h.glob}</code>
            </li>
          ))}
        </ul>
      )}
      <div className="mt-2 flex flex-wrap gap-3 text-xs">
        {item.changesetId && item.projectSlug && (
          <Link
            href={`/orgs/${slug}/projects/${item.projectSlug}/changesets/${item.changesetId}`}
            className="underline decoration-dotted text-zinc-600 hover:text-zinc-900 dark:text-zinc-300 dark:hover:text-zinc-100"
          >
            View changeset →
          </Link>
        )}
        {prUrl && (
          <a
            href={prUrl}
            target="_blank"
            rel="noreferrer"
            className="underline decoration-dotted text-zinc-600 hover:text-zinc-900 dark:text-zinc-300 dark:hover:text-zinc-100"
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
  await api(
    `/v1/orgs/${slug}/projects/${projectSlug}/approvals/${approvalId}/resolve`,
    { method: 'POST', body: JSON.stringify({ resolution }), session },
  );
}

function ResolveForm({ slug, approvalId }: { slug: string; approvalId: string }) {
  return (
    <div className="flex flex-col gap-1.5">
      {(['approve', 'reject'] as const).map((kind) => (
        <form action={resolveAction} key={kind}>
          <input type="hidden" name="slug" value={slug} />
          <input type="hidden" name="projectSlug" value="-" />
          <input type="hidden" name="approvalId" value={approvalId} />
          <input type="hidden" name="resolution" value={kind} />
          <Button variant={kind === 'approve' ? 'primary' : 'destructive'}>{kind}</Button>
        </form>
      ))}
    </div>
  );
}
