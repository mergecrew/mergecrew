import Link from 'next/link';
import { api } from '@/lib/api';
import { requireSession } from '@/lib/session';
import { hasRole } from '@/lib/role';
import { Card, Chip } from '@/components/ui';
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
  if (r?.kind !== 'blast_radius') {
    return null;
  }
  return (
    <div className="rounded border border-rose-300 bg-rose-50 p-3 text-sm text-rose-900 dark:border-rose-700/40 dark:bg-rose-950/30 dark:text-rose-200">
      <strong>This changeset was blocked by the blast-radius gate.</strong>
      <ul className="mt-2 space-y-1 text-xs">
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
      <p className="mt-2 text-xs">
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
  const cs = await api<any>(`/v1/orgs/${slug}/projects/${projectSlug}/changesets/${csId}`, { session });
  const isAdmin = await hasRole(slug, session, 'admin');
  const canRollback = isAdmin && cs.status === 'promoted' && cs.prNumber && !cs.revertPrNumber;
  return (
    <main className="mx-auto max-w-3xl p-6 space-y-4">
      <header className="flex items-baseline justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">{cs.title}</h1>
          <p className="text-sm font-mono text-zinc-500 space-x-1">
            <span>{cs.id}</span>
            <span>·</span>
            <Chip>{cs.status}</Chip>
            {cs.isDryRun && <Chip kind="medium">DRY RUN</Chip>}
          </p>
        </div>
        <div className="flex gap-2">
          {canRollback && (
            <RollbackButton slug={slug} projectSlug={projectSlug} csId={csId} />
          )}
          {cs.prNumber && (
            <Link
              href={`/orgs/${slug}/projects/${projectSlug}/changesets/${csId}/diff`}
              className="rounded border px-3 py-1 text-sm hover:bg-zinc-100 dark:border-zinc-800 dark:hover:bg-zinc-800"
            >
              View diff
            </Link>
          )}
        </div>
      </header>
      {cs.revertPrNumber && cs.revertPrUrl && (
        <div className="rounded border border-zinc-300 bg-zinc-50 p-3 text-sm dark:border-zinc-700 dark:bg-zinc-900/60">
          <strong>Rolled back via revert PR.</strong>{' '}
          <a
            href={cs.revertPrUrl}
            target="_blank"
            rel="noreferrer"
            className="underline decoration-dotted hover:text-zinc-700 dark:hover:text-zinc-300"
          >
            #{cs.revertPrNumber} →
          </a>
        </div>
      )}
      {cs.isDryRun && (
        <div className="rounded border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-700/40 dark:bg-amber-950/30 dark:text-amber-200">
          <strong>This changeset was produced in dry-run mode.</strong> The agent ran, generated the
          diff, and recorded the changeset — but the runner skipped <code>git push</code>, PR
          creation, and deploy. Turn off dry-run in project settings to ship the next run for real.
        </div>
      )}
      {cs.status === 'blocked' && cs.blockedReason && (
        <BlockedReasonCallout reason={cs.blockedReason} />
      )}
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
