'use client';

import { useState, useTransition } from 'react';
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

  const toggle = () => {
    const next = !enabled;
    setEnabled(next);
    startTransition(async () => {
      await updateProjectAction(slug, projectSlug, { dryRun: next });
    });
  };

  return (
    <div className="space-y-3">
      <label className="flex items-start gap-3 text-sm">
        <input
          type="checkbox"
          className="mt-0.5"
          checked={enabled}
          onChange={toggle}
          disabled={pending || !canEdit}
        />
        <span>
          <span className="font-medium">Dry-run mode</span>
          <span className="block text-zinc-600 dark:text-zinc-400">
            Agents still run and produce changesets with diffs, but the runner skips{' '}
            <code>git push</code>, PR creation, and deploy. Use this for the first week on a new
            repo, or any time you want to evaluate the agent loop without remote side-effects.
          </span>
        </span>
      </label>
      {enabled && (
        <div className="rounded bg-amber-50 p-2 text-xs text-amber-800 dark:bg-amber-900/20 dark:text-amber-300">
          Dry-run is <strong>on</strong>. New changesets land with a <code>DRY RUN</code> badge and
          a &quot;Promote to real PR&quot; button on the changeset detail page.
        </div>
      )}
      <p className="text-xs text-zinc-500">
        <a
          href="https://github.com/mergecrew/mergecrew/blob/main/docs/03-infrastructure/09-dry-run.md"
          target="_blank"
          rel="noreferrer"
          className="underline decoration-dotted hover:text-zinc-700 dark:hover:text-zinc-300"
        >
          Learn more about dry-run mode →
        </a>
      </p>
      {!canEdit && (
        <p className="text-xs text-zinc-500">Only operators can change this.</p>
      )}
    </div>
  );
}
