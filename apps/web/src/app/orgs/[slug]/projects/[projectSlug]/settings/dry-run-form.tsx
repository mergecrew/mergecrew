'use client';

import { useState, useTransition } from 'react';
import { ToggleRow } from '@/components/ui';
import { updateProjectAction } from './settings-actions';

export function DryRunForm({
  slug,
  projectSlug,
  initialDryRun,
  canEdit,
}: {
  slug: string;
  projectSlug: string;
  initialDryRun: boolean;
  canEdit: boolean;
}) {
  const [enabled, setEnabled] = useState(initialDryRun);
  const [pending, startTransition] = useTransition();

  const setTo = (next: boolean) => {
    if (!canEdit || pending) return;
    setEnabled(next);
    startTransition(async () => {
      await updateProjectAction(slug, projectSlug, { dryRun: next });
    });
  };

  return (
    <div className="space-y-3">
      <ToggleRow
        label="Dry-run mode"
        desc={
          <>
            Agents still run and produce changesets with diffs, but the runner skips{' '}
            <code className="font-mono text-[12px] text-ink">git push</code>, PR creation, and
            deploy. Use this for the first week on a new repo, or any time you want to evaluate the
            agent loop without remote side-effects.
          </>
        }
        value={enabled}
        onChange={setTo}
      />
      {enabled && (
        <div className="border border-warn bg-warn/20 p-3 text-[12.5px] text-ink">
          Dry-run is <strong>on</strong>. New changesets land with a{' '}
          <code className="font-mono text-[12px]">DRY RUN</code> badge and a &quot;Promote to real
          PR&quot; button on the changeset detail page.
        </div>
      )}
      <p className="m-0 text-[12px] text-muted">
        <a
          href="https://github.com/mergecrew/mergecrew/blob/main/docs/03-infrastructure/09-dry-run.md"
          target="_blank"
          rel="noreferrer"
          className="text-accent underline-offset-[3px] hover:underline"
        >
          Learn more about dry-run mode →
        </a>
      </p>
      {!canEdit && <p className="m-0 text-[12px] text-muted">Only operators can change this.</p>}
    </div>
  );
}
