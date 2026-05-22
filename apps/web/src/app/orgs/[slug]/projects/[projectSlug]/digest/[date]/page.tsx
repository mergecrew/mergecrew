import { api, apiOr404 } from '@/lib/api';
import { requireSession } from '@/lib/session';
import { Card, Chip, Button, PageHead } from '@/components/ui';

export default async function DigestPage({
  params,
}: {
  params: Promise<{ slug: string; projectSlug: string; date: string }>;
}) {
  const { slug, projectSlug, date } = await params;
  const session = await requireSession();
  const digest = await apiOr404<{ items: any[]; date: string; totalCost: number }>(
    `/v1/orgs/${slug}/projects/${projectSlug}/digest/${date}`,
    { session },
  );

  return (
    <main className="mx-auto max-w-[1080px] px-4 py-5 sm:px-9 sm:py-7">
      <PageHead
        crumb={[
          { label: slug, href: `/orgs/${slug}` },
          { label: projectSlug, href: `/orgs/${slug}/projects/${projectSlug}` },
          { label: 'Digests' },
        ]}
        title={`Digest · ${digest.date}`}
        meta={
          <span className="font-mono text-[12.5px] text-muted">
            {digest.items.length} changeset{digest.items.length === 1 ? '' : 's'} · est.{' '}
            <b className="text-ink">${digest.totalCost.toFixed(2)}</b>
          </span>
        }
      />

      {digest.items.length === 0 && (
        <Card className="p-5">
          <p className="text-[13.5px] text-muted">Quiet day — no changesets dispatched.</p>
        </Card>
      )}

      <ul className="space-y-3 m-0 list-none p-0">
        {digest.items.map((cs) => (
          <li key={cs.id}>
            <ChangesetCard cs={cs} orgSlug={slug} projectSlug={projectSlug} />
          </li>
        ))}
      </ul>
    </main>
  );
}

function ChangesetCard({
  cs,
  orgSlug,
  projectSlug,
}: {
  cs: any;
  orgSlug: string;
  projectSlug: string;
}) {
  return (
    <Card className="p-5">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="text-[15px] font-medium tracking-[-0.005em]">{cs.title}</div>
          {cs.whyParagraph && (
            <p className="mt-2 text-[13.5px] leading-[1.55] text-ink-2">{cs.whyParagraph}</p>
          )}
          <div className="mt-3 flex flex-wrap items-center gap-3 font-mono text-[11.5px] text-muted">
            <Chip kind={(cs.riskChip ?? 'low') as any}>{cs.riskChip ?? 'low'}</Chip>
            <span>
              <b className="text-ink">${Number(cs.estimatedUsd ?? 0).toFixed(2)}</b>
            </span>
            {cs.prUrl && (
              <a
                href={cs.prUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-accent underline-offset-[3px] hover:underline"
              >
                PR
              </a>
            )}
            {cs.testSummary && (
              <span>
                tests {cs.testSummary.passed}/{cs.testSummary.passed + cs.testSummary.failed}
              </span>
            )}
            <span className="text-muted-2">{cs.id}</span>
          </div>
        </div>
        <div className="flex shrink-0 flex-col gap-2">
          <DecisionForm
            orgSlug={orgSlug}
            projectSlug={projectSlug}
            csId={cs.id}
            kind="promote"
            label="Promote"
          />
          <DecisionForm
            orgSlug={orgSlug}
            projectSlug={projectSlug}
            csId={cs.id}
            kind="rollback"
            label="Rollback"
          />
          <DecisionForm
            orgSlug={orgSlug}
            projectSlug={projectSlug}
            csId={cs.id}
            kind="defer"
            label="Defer"
          />
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
  await api(`/v1/orgs/${orgSlug}/projects/${projectSlug}/changesets/${csId}/decisions`, {
    method: 'POST',
    body: JSON.stringify({ kind }),
    session,
  });
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
      <Button
        size="sm"
        variant={kind === 'promote' ? 'energy' : kind === 'rollback' ? 'danger' : 'ghost'}
      >
        {label}
      </Button>
    </form>
  );
}
