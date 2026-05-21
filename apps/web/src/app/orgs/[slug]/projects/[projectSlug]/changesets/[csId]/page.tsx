import Link from 'next/link';
import { apiOr404 } from '@/lib/api';
import { requireSession } from '@/lib/session';
import { hasRole } from '@/lib/role';
import { Card, Chip, PageHead, LinkButton, Label } from '@/components/ui';
import { RollbackButton } from './rollback-button';

interface BlastRadiusReason {
  kind: 'blast_radius';
  filesChanged: number;
  linesChanged: number;
  maxFilesChanged: number;
  maxLinesChanged: number;
  filesOverLimit: boolean;
  linesOverLimit: boolean;
  deniedHits: { path: string; glob: string }[];
}

function BlockedReasonCallout({ reason }: { reason: any }) {
  const r = reason as BlastRadiusReason;
  if (r?.kind !== 'blast_radius') return null;
  return (
    <div className="border border-energy bg-energy-soft p-4 text-[13.5px] text-energy-deep">
      <strong className="text-energy-deep">
        This changeset was blocked by the blast-radius gate.
      </strong>
      <ul className="mt-2 space-y-1 text-[12.5px]">
        {r.filesOverLimit && (
          <li>
            • Files changed: <strong>{r.filesChanged}</strong> (cap: {r.maxFilesChanged})
          </li>
        )}
        {r.linesOverLimit && (
          <li>
            • Lines changed: <strong>{r.linesChanged}</strong> (cap: {r.maxLinesChanged})
          </li>
        )}
        {r.deniedHits.length > 0 && (
          <li>
            • Denied-path hits:
            <ul className="ml-3 mt-1 space-y-0.5 font-mono">
              {r.deniedHits.map((h, i) => (
                <li key={i}>
                  <code>{h.path}</code> ← matched <code>{h.glob}</code>
                </li>
              ))}
            </ul>
          </li>
        )}
      </ul>
      <p className="mt-3 text-[12.5px]">
        Raise the limits or trim the deny-list under <em>Settings → Guardrails</em>. The next run
        will produce a fresh changeset against current HEAD.
      </p>
    </div>
  );
}

export default async function ChangesetDetail({
  params,
}: {
  params: Promise<{ slug: string; projectSlug: string; csId: string }>;
}) {
  const { slug, projectSlug, csId } = await params;
  const session = await requireSession();
  const cs = await apiOr404<any>(
    `/v1/orgs/${slug}/projects/${projectSlug}/changesets/${csId}`,
    { session },
  );
  const isAdmin = await hasRole(slug, session, 'admin');
  const canRollback = isAdmin && cs.status === 'promoted' && cs.prNumber && !cs.revertPrNumber;

  return (
    <main className="mx-auto max-w-[1280px] px-9 py-7">
      <PageHead
        crumb={[
          { label: slug, href: `/orgs/${slug}` },
          { label: projectSlug, href: `/orgs/${slug}/projects/${projectSlug}` },
          {
            label: 'Changesets',
            href: `/orgs/${slug}/projects/${projectSlug}/changesets`,
          },
          { label: cs.prNumber ? `#${cs.prNumber}` : cs.id.slice(0, 8) },
        ]}
        title={cs.title ?? cs.id.slice(0, 8)}
        meta={
          <div className="flex flex-wrap items-center gap-3 font-mono text-[12px] text-muted">
            <span>{cs.id}</span>
            <Chip>{cs.status}</Chip>
            {cs.isDryRun && <Chip kind="medium">DRY RUN</Chip>}
          </div>
        }
        actions={
          <>
            {canRollback && <RollbackButton slug={slug} projectSlug={projectSlug} csId={csId} />}
            {cs.prNumber && (
              <LinkButton
                href={`/orgs/${slug}/projects/${projectSlug}/changesets/${csId}/diff`}
                variant="ghost"
                size="sm"
              >
                View diff
              </LinkButton>
            )}
          </>
        }
      />

      <div className="space-y-4">
        {cs.revertPrNumber && cs.revertPrUrl && (
          <div className="border border-ink bg-ink p-3 text-[13.5px] text-paper">
            <strong>Rolled back via revert PR.</strong>{' '}
            <a
              href={cs.revertPrUrl}
              target="_blank"
              rel="noreferrer"
              className="underline decoration-dotted hover:text-accent-soft"
            >
              #{cs.revertPrNumber} →
            </a>
          </div>
        )}
        {cs.isDryRun && (
          <div className="border border-warn bg-warn/20 p-4 text-[13.5px] text-ink">
            <strong>This changeset was produced in dry-run mode.</strong> The agent ran, generated
            the diff, and recorded the changeset — but the runner skipped <code>git push</code>,
            PR creation, and deploy. Turn off dry-run in project settings to ship the next run for
            real.
          </div>
        )}
        {cs.status === 'blocked' && cs.blockedReason && (
          <BlockedReasonCallout reason={cs.blockedReason} />
        )}

        {cs.whyParagraph && (
          <Card className="p-5">
            <Label className="block mb-2">Why</Label>
            <p className="m-0 whitespace-pre-wrap text-[13.5px] leading-[1.6] text-ink-2">
              {cs.whyParagraph}
            </p>
          </Card>
        )}

        <Card className="p-5">
          <div className="grid grid-cols-2 gap-5 text-[13.5px]">
            <div>
              <Label className="block mb-1">Branch</Label>
              <code className="font-mono text-[12.5px] text-ink">{cs.branch}</code>
            </div>
            <div>
              <Label className="block mb-1">PR</Label>
              {cs.prUrl ? (
                <a className="text-accent" href={cs.prUrl}>
                  #{cs.prNumber}
                </a>
              ) : (
                <span className="text-muted">—</span>
              )}
              <AgentReviewChip review={cs.agentReview} hasPr={!!cs.prNumber} />
            </div>
            <div>
              <Label className="block mb-1">Risk</Label>
              <Chip kind={(cs.riskChip ?? 'low') as any}>{cs.riskChip ?? 'low'}</Chip>
            </div>
            <div>
              <Label className="block mb-1">Cost</Label>
              <span className="font-mono text-[13.5px] text-ink">
                ${Number(cs.estimatedUsd ?? 0).toFixed(2)}
              </span>
            </div>
          </div>
        </Card>
      </div>
    </main>
  );
}

function AgentReviewChip({
  review,
  hasPr,
}: {
  review:
    | { verdict: 'approve' | 'request_changes'; flippedToReady: boolean; at: string | null }
    | null;
  hasPr: boolean;
}) {
  if (!hasPr) return null;
  if (!review) {
    return (
      <div className="mt-2">
        <Chip kind="neutral">awaiting agent review</Chip>
      </div>
    );
  }
  if (review.verdict === 'approve') {
    return (
      <div className="mt-2">
        <Chip kind="low">
          {review.flippedToReady ? 'agent approved · ready for human review' : 'agent approved'}
        </Chip>
      </div>
    );
  }
  return (
    <div className="mt-2">
      <Chip kind="medium">agent: requested changes</Chip>
    </div>
  );
}
