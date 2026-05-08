import { api } from '@/lib/api';
import { requireSession } from '@/lib/session';
import { Card, Chip, Button } from '@/components/ui';

export default async function DigestPage({
  params,
}: {
  params: Promise<{ slug: string; projectSlug: string; date: string }>;
}) {
  const { slug, projectSlug, date } = await params;
  const session = await requireSession();
  const digest = await api<{ items: any[]; date: string; totalCost: number }>(
    `/v1/orgs/${slug}/projects/${projectSlug}/digest/${date}`,
    { session },
  );

  return (
    <main className="mx-auto max-w-2xl p-4 sm:p-6 space-y-4">
      <header>
        <h1 className="text-xl font-semibold">Digest · {digest.date}</h1>
        <p className="text-sm text-zinc-500">
          {digest.items.length} changeset{digest.items.length === 1 ? '' : 's'} · est. ${digest.totalCost.toFixed(2)}
        </p>
      </header>

      {digest.items.length === 0 && (
        <Card><p className="text-zinc-500">No changesets today.</p></Card>
      )}

      <ul className="space-y-3">
        {digest.items.map((cs) => (
          <li key={cs.id}>
            <ChangesetCard cs={cs} orgSlug={slug} projectSlug={projectSlug} />
          </li>
        ))}
      </ul>
    </main>
  );
}

function ChangesetCard({ cs, orgSlug, projectSlug }: { cs: any; orgSlug: string; projectSlug: string }) {
  return (
    <Card>
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1">
          <div className="font-medium">{cs.title}</div>
          {cs.whyParagraph && <p className="text-sm text-zinc-600 dark:text-zinc-300 mt-1">{cs.whyParagraph}</p>}
          <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
            <Chip kind={(cs.riskChip ?? 'low') as any}>{cs.riskChip ?? 'low'}</Chip>
            <span className="text-zinc-500">${Number(cs.estimatedUsd ?? 0).toFixed(2)}</span>
            {cs.prUrl && <a href={cs.prUrl} target="_blank" className="text-accent">PR</a>}
            {cs.testSummary && (
              <span className="text-zinc-500">tests {cs.testSummary.passed}/{cs.testSummary.passed + cs.testSummary.failed}</span>
            )}
            <span className="font-mono text-zinc-400">{cs.id}</span>
          </div>
        </div>
        <div className="flex flex-col gap-1.5">
          <DecisionForm orgSlug={orgSlug} projectSlug={projectSlug} csId={cs.id} kind="promote" label="Promote" />
          <DecisionForm orgSlug={orgSlug} projectSlug={projectSlug} csId={cs.id} kind="rollback" label="Rollback" />
          <DecisionForm orgSlug={orgSlug} projectSlug={projectSlug} csId={cs.id} kind="defer" label="Defer" />
        </div>
      </div>
    </Card>
  );
}

async function decisionAction(formData: FormData) {
  'use server';
  const orgSlug = String(formData.get('orgSlug') ?? '');
  const projectSlug = String(formData.get('projectSlug') ?? '');
  const csId = String(formData.get('csId') ?? '');
  const kind = String(formData.get('kind') ?? '');
  const session = await requireSession();
  await api(
    `/v1/orgs/${orgSlug}/projects/${projectSlug}/changesets/${csId}/decisions`,
    { method: 'POST', body: JSON.stringify({ kind }), session },
  );
}

function DecisionForm({
  orgSlug,
  projectSlug,
  csId,
  kind,
  label,
}: {
  orgSlug: string;
  projectSlug: string;
  csId: string;
  kind: string;
  label: string;
}) {
  return (
    <form action={decisionAction}>
      <input type="hidden" name="orgSlug" value={orgSlug} />
      <input type="hidden" name="projectSlug" value={projectSlug} />
      <input type="hidden" name="csId" value={csId} />
      <input type="hidden" name="kind" value={kind} />
      <Button variant={kind === 'promote' ? 'primary' : kind === 'rollback' ? 'destructive' : 'secondary'}>
        {label}
      </Button>
    </form>
  );
}
