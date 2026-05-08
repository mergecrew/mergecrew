import { api } from '@/lib/api';
import { requireSession } from '@/lib/session';
import { Card, Chip } from '@/components/ui';

export default async function ChangesetDetail({
  params,
}: {
  params: Promise<{ slug: string; projectSlug: string; csId: string }>;
}) {
  const { slug, projectSlug, csId } = await params;
  const session = await requireSession();
  const cs = await api<any>(`/v1/orgs/${slug}/projects/${projectSlug}/changesets/${csId}`, { session });
  return (
    <main className="mx-auto max-w-3xl p-6 space-y-4">
      <header>
        <h1 className="text-xl font-semibold">{cs.title}</h1>
        <p className="text-sm font-mono text-zinc-500">{cs.id} · <Chip>{cs.status}</Chip></p>
      </header>
      {cs.whyParagraph && (
        <Card>
          <h2 className="text-sm font-medium text-zinc-500 mb-1">Why</h2>
          <p className="whitespace-pre-wrap">{cs.whyParagraph}</p>
        </Card>
      )}
      <Card>
        <div className="grid grid-cols-2 gap-2 text-sm">
          <div><span className="text-zinc-500">Branch</span><br/><code>{cs.branch}</code></div>
          <div><span className="text-zinc-500">PR</span><br/>{cs.prUrl ? <a className="text-accent" href={cs.prUrl}>#{cs.prNumber}</a> : '—'}</div>
          <div><span className="text-zinc-500">Risk</span><br/><Chip kind={(cs.riskChip ?? 'low') as any}>{cs.riskChip ?? 'low'}</Chip></div>
          <div><span className="text-zinc-500">Cost</span><br/>${Number(cs.estimatedUsd ?? 0).toFixed(2)}</div>
        </div>
      </Card>
    </main>
  );
}
