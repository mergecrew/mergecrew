'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui';
import { rollbackChangesetAction } from './actions';

export function RollbackButton({
  slug,
  projectSlug,
  csId,
}: {
  slug: string;
  projectSlug: string;
  csId: string;
}) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  const submit = () => {
    setError(null);
    startTransition(async () => {
      try {
        await rollbackChangesetAction(slug, projectSlug, csId);
        setOpen(false);
        router.refresh();
      } catch (e: any) {
        setError(String(e?.message ?? e));
      }
    });
  };

  if (!open) {
    return (
      <Button variant="destructive" onClick={() => setOpen(true)}>
        Roll back
      </Button>
    );
  }

  return (
    <div className="rounded border border-rose-300 bg-rose-50 p-3 text-sm dark:border-rose-700/40 dark:bg-rose-950/30">
      <p className="text-rose-900 dark:text-rose-200">
        <strong>Confirm rollback.</strong> This opens a <code>git revert</code> PR for the merged
        change. If the original changeset touched database migrations, you&apos;ll need to handle
        the schema reversal manually — review the revert PR before merging it.
      </p>
      {error && (
        <p className="mt-2 rounded bg-rose-100 p-2 text-xs text-rose-900 dark:bg-rose-900/40 dark:text-rose-100">
          {error}
        </p>
      )}
      <div className="mt-3 flex gap-2">
        <Button variant="destructive" onClick={submit} disabled={pending}>
          {pending ? 'Opening revert PR…' : 'Yes, roll back'}
        </Button>
        <Button variant="secondary" onClick={() => setOpen(false)} disabled={pending}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
