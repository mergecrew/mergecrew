'use client';

import { useMemo, useState, useTransition } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Button, Card, Chip } from '@/components/ui';
import {
  dropChangesetAction,
  promoteAction,
  type PromoteRunSnapshot,
} from '@/app/orgs/[slug]/projects/[projectSlug]/settings/settings-actions';

export interface DigestChangeset {
  id: string;
  title: string;
  whyParagraph: string | null;
  prNumber: number | null;
  prUrl: string | null;
  branch: string;
  riskChip: string | null;
  updatedAt: string;
}

export interface PromoteDigestProps {
  orgSlug: string;
  projectSlug: string;
  changesets: DigestChangeset[];
  latestRun: PromoteRunSnapshot | null;
  /**
   * Effective base PR branch (#469) — used to interpolate the dev
   * preview link as `${baseBranch}@${shortSha}` style. Optional; when
   * missing the row just shows the branch + PR link.
   */
  basePrBranch?: string | null;
  /**
   * PromotionStrategy.kind (#478). Used to relabel the CTA and
   * success copy when the strategy is `single_env` — promote runs
   * no git there, so "Mark reviewed" matches the actual semantics.
   */
  strategyKind?: string | null;
}

/**
 * Daily promote ritual (#472). Renders the human-approved subset
 * picker and the "Build release" CTA. Three per-row actions:
 *   - Approve (default; included in this cycle)
 *   - Defer   (stays on dev; reappears next cycle)
 *   - Drop    (revert PR opened on basePrBranch; hidden permanently)
 *
 * Approve/Defer state persists in URL search params so refresh or
 * shareable links don't lose the operator's selections.
 *
 * Conflict surface: when the latest PromoteRun reports
 * `status='conflict'`, the page shows which changeset failed +
 * which files conflicted, with a "Re-run with current resolution"
 * button. The user resolves upstream, the conflicted release
 * branch is left pushed; re-running rebuilds from a fresh branch.
 */
export function PromoteDigest({
  orgSlug,
  projectSlug,
  changesets,
  latestRun,
  basePrBranch,
  strategyKind,
}: PromoteDigestProps) {
  const isSingleEnv = strategyKind === 'single_env';
  const ctaLabel = isSingleEnv ? 'Mark reviewed' : 'Build release';
  const ctaPending = isSingleEnv ? 'Marking…' : 'Building…';
  const router = useRouter();
  const searchParams = useSearchParams();

  // Default is approve. We only persist the deferred subset in URL to
  // keep URLs short (most changesets are approved by default; flipping
  // a few to defer is the common edit).
  const deferred = useMemo(() => {
    const raw = searchParams?.get('defer') ?? '';
    return new Set(raw.split(',').map((s) => s.trim()).filter(Boolean));
  }, [searchParams]);

  const setDeferred = (next: Set<string>) => {
    const params = new URLSearchParams(searchParams?.toString() ?? '');
    const list = Array.from(next).sort();
    if (list.length === 0) {
      params.delete('defer');
    } else {
      params.set('defer', list.join(','));
    }
    const qs = params.toString();
    router.replace(qs ? `?${qs}` : '?', { scroll: false });
  };

  const toggle = (id: string, approve: boolean) => {
    const next = new Set(deferred);
    if (approve) next.delete(id);
    else next.add(id);
    setDeferred(next);
  };

  const approvedIds = changesets.map((c) => c.id).filter((id) => !deferred.has(id));
  const counts = {
    approved: approvedIds.length,
    deferred: changesets.filter((c) => deferred.has(c.id)).length,
  };

  const [pending, startTransition] = useTransition();
  const [runFlash, setRunFlash] = useState<PromoteRunSnapshot | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const onBuildRelease = () => {
    if (approvedIds.length === 0) return;
    setActionError(null);
    startTransition(async () => {
      try {
        const run = await promoteAction(orgSlug, projectSlug, approvedIds);
        setRunFlash(run);
      } catch (e: any) {
        setActionError(String(e?.message ?? e));
      }
    });
  };

  // When the engine returned a conflict, this is the active surface
  // for the re-run affordance. Otherwise we fall back to the latest
  // run pulled from the server (which may also be a conflict from a
  // prior page load).
  const conflictRun =
    runFlash?.status === 'conflict'
      ? runFlash
      : latestRun?.status === 'conflict'
        ? latestRun
        : null;

  if (changesets.length === 0 && !conflictRun) {
    return (
      <Card data-testid="promote-digest-empty">
        <div className="space-y-1">
          <div className="font-medium">Nothing to promote</div>
          <p className="text-sm text-zinc-600 dark:text-zinc-300">
            Agents haven&apos;t merged anything new since the last promote. Mergecrew
            runs daily — come back tomorrow.
          </p>
        </div>
      </Card>
    );
  }

  return (
    <section className="space-y-3" data-testid="promote-digest">
      <div className="flex items-baseline justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold">
            {isSingleEnv ? 'Ready to review' : 'Ready to promote'}
          </h2>
          <p className="text-xs text-zinc-500">
            {isSingleEnv ? (
              <>
                Approved changesets are marked reviewed and leave the digest — no
                git operations, since this is a single-environment project.
                Deferred changes reappear next cycle. Drop opens a revert PR on{' '}
                <span className="font-mono">{basePrBranch ?? 'your base branch'}</span>.
              </>
            ) : (
              <>
                Approved changesets get cherry-picked onto a release branch and shipped via your CI.
                Deferred changes carry forward to the next cycle. Drop opens a revert PR on{' '}
                <span className="font-mono">{basePrBranch ?? 'your base branch'}</span>.
              </>
            )}
          </p>
        </div>
        <div className="text-xs text-zinc-500">
          <span className="font-medium text-emerald-700 dark:text-emerald-400">{counts.approved}</span>{' '}
          approved · {counts.deferred} deferred
        </div>
      </div>

      {conflictRun && (
        <ConflictPanel
          run={conflictRun}
          changesets={changesets}
          onRerun={onBuildRelease}
          pending={pending}
          approvedCount={approvedIds.length}
        />
      )}

      {runFlash?.status === 'completed' && (
        <Card className="border-emerald-200 bg-emerald-50/50 dark:border-emerald-700/40 dark:bg-emerald-950/30">
          <div className="text-sm">
            {isSingleEnv ? (
              <>
                <span className="font-medium">Marked reviewed.</span> Approved
                changesets have left the digest.
              </>
            ) : (
              <>
                <span className="font-medium">Release built.</span>{' '}
                <span className="font-mono text-xs">{runFlash.releaseRef}</span> is on the remote.
                Your CI takes over from here.
              </>
            )}
          </div>
        </Card>
      )}

      {runFlash?.status === 'failed' && (
        <Card className="border-rose-200 bg-rose-50/50 dark:border-rose-700/40 dark:bg-rose-950/30">
          <div className="text-sm">
            <span className="font-medium">Release failed:</span>{' '}
            <span className="text-rose-700 dark:text-rose-300">{runFlash.failureReason}</span>
          </div>
        </Card>
      )}

      {actionError && (
        <Card className="border-rose-200 bg-rose-50/50 dark:border-rose-700/40 dark:bg-rose-950/30">
          <div className="text-sm text-rose-700 dark:text-rose-300">{actionError}</div>
        </Card>
      )}

      <ul className="space-y-2">
        {changesets.map((cs) => (
          <DigestRow
            key={cs.id}
            cs={cs}
            orgSlug={orgSlug}
            projectSlug={projectSlug}
            isApproved={!deferred.has(cs.id)}
            onToggle={(approve) => toggle(cs.id, approve)}
          />
        ))}
      </ul>

      <div className="flex items-center justify-end gap-3">
        <span className="text-xs text-zinc-500">
          {counts.approved} of {changesets.length} approved
        </span>
        <Button
          variant="primary"
          disabled={pending || approvedIds.length === 0}
          onClick={onBuildRelease}
        >
          {pending ? ctaPending : ctaLabel}
        </Button>
      </div>
    </section>
  );
}

function DigestRow({
  cs,
  orgSlug,
  projectSlug,
  isApproved,
  onToggle,
}: {
  cs: DigestChangeset;
  orgSlug: string;
  projectSlug: string;
  isApproved: boolean;
  onToggle: (approve: boolean) => void;
}) {
  const [dropping, startDrop] = useTransition();
  const [dropResult, setDropResult] = useState<{ url: string } | null>(null);
  const [dropError, setDropError] = useState<string | null>(null);

  const onDrop = () => {
    const ok = window.confirm(
      `Open a revert PR for "${cs.title}"? You'll review and merge it yourself. This changeset won't reappear in future digests.`,
    );
    if (!ok) return;
    setDropError(null);
    startDrop(async () => {
      try {
        const r = await dropChangesetAction(orgSlug, projectSlug, cs.id);
        setDropResult({ url: r.revertPrUrl });
      } catch (e: any) {
        setDropError(String(e?.message ?? e));
      }
    });
  };

  if (dropResult) {
    return (
      <li className="rounded border border-zinc-200 bg-zinc-50/50 p-3 text-sm text-zinc-600 dark:border-zinc-700 dark:bg-zinc-900/30 dark:text-zinc-400">
        Dropped <span className="font-medium">{cs.title}</span> —{' '}
        <a
          className="underline"
          href={dropResult.url}
          target="_blank"
          rel="noreferrer"
        >
          revert PR opened
        </a>
        . The page will refresh on next load.
      </li>
    );
  }

  return (
    <li className="rounded border p-3 dark:border-zinc-800">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            {cs.riskChip && (
              <Chip kind={(cs.riskChip as 'low' | 'medium' | 'high') ?? 'neutral'}>{cs.riskChip}</Chip>
            )}
            <span className="font-medium">{cs.title}</span>
          </div>
          {cs.whyParagraph && (
            <p className="text-sm text-zinc-600 dark:text-zinc-300">{cs.whyParagraph}</p>
          )}
          <div className="flex flex-wrap items-center gap-3 text-xs text-zinc-500">
            {cs.prUrl && cs.prNumber != null && (
              <a className="underline" href={cs.prUrl} target="_blank" rel="noreferrer">
                PR #{cs.prNumber}
              </a>
            )}
            <span className="font-mono">{cs.branch}</span>
            <a
              className="underline"
              href={`/orgs/${orgSlug}/projects/${projectSlug}/changesets/${cs.id}`}
            >
              detail
            </a>
          </div>
          {dropError && (
            <div className="text-xs text-rose-700 dark:text-rose-300">{dropError}</div>
          )}
        </div>
        <div className="flex shrink-0 flex-col items-end gap-2">
          <div className="flex items-center gap-3 text-sm">
            <label className="flex items-center gap-1.5">
              <input
                type="radio"
                name={`decision-${cs.id}`}
                checked={isApproved}
                onChange={() => onToggle(true)}
              />
              <span>Approve</span>
            </label>
            <label className="flex items-center gap-1.5">
              <input
                type="radio"
                name={`decision-${cs.id}`}
                checked={!isApproved}
                onChange={() => onToggle(false)}
              />
              <span>Defer</span>
            </label>
          </div>
          <button
            type="button"
            className="text-xs text-rose-700 underline hover:text-rose-900 disabled:opacity-60 dark:text-rose-400 dark:hover:text-rose-200"
            onClick={onDrop}
            disabled={dropping}
          >
            {dropping ? 'Opening revert…' : 'Drop'}
          </button>
        </div>
      </div>
    </li>
  );
}

function ConflictPanel({
  run,
  changesets,
  onRerun,
  pending,
  approvedCount,
}: {
  run: PromoteRunSnapshot;
  changesets: DigestChangeset[];
  onRerun: () => void;
  pending: boolean;
  approvedCount: number;
}) {
  const conflictedCs = changesets.find((c) => c.id === run.conflict?.changesetId);
  return (
    <Card className="border-amber-200 bg-amber-50/50 dark:border-amber-700/40 dark:bg-amber-950/30">
      <div className="space-y-2">
        <div className="font-medium">Last release attempt stopped on a cherry-pick conflict.</div>
        <p className="text-sm text-zinc-700 dark:text-zinc-200">
          Conflicted changeset:{' '}
          <span className="font-medium">{conflictedCs?.title ?? run.conflict?.changesetId}</span>
          {run.releaseRef && (
            <>
              {' '}
              · partial branch <span className="font-mono">{run.releaseRef}</span> is on the remote.
            </>
          )}
        </p>
        {run.conflict?.files && run.conflict.files.length > 0 && (
          <ul className="text-xs font-mono text-zinc-600 dark:text-zinc-300">
            {run.conflict.files.slice(0, 10).map((f) => (
              <li key={f}>· {f}</li>
            ))}
            {run.conflict.files.length > 10 && (
              <li>… {run.conflict.files.length - 10} more</li>
            )}
          </ul>
        )}
        <p className="text-xs text-zinc-600 dark:text-zinc-400">
          Resolve the conflict in your editor (clone the branch, fix the files, push). Then re-run
          to rebuild from a fresh release branch.
        </p>
        <div>
          <Button
            variant="primary"
            disabled={pending || approvedCount === 0}
            onClick={onRerun}
          >
            {pending ? 'Rebuilding…' : 'Re-run with current selection'}
          </Button>
        </div>
      </div>
    </Card>
  );
}
