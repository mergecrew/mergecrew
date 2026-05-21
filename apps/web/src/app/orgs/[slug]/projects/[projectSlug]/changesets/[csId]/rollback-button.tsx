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
      <Button variant="danger" size="sm" onClick={() => setOpen(true)}>
        Roll back
      </Button>
    );
  }

  return (
    <div className="border border-energy bg-energy-soft p-4 text-[13px]">
      <p className="m-0 text-energy-deep">
        <strong>Confirm rollback.</strong> This opens a <code>git revert</code> PR for the merged
        change. If the original changeset touched database migrations, you&apos;ll need to handle
        the schema reversal manually — review the revert PR before merging it.
      </p>
      {error && (
        <p className="mt-2 border border-energy bg-paper p-2 text-[12px] text-energy-deep">
          {error}
        </p>
      )}
      <div className="mt-3 flex gap-2">
        <Button variant="danger" size="sm" onClick={submit} disabled={pending}>
          {pending ? 'Opening revert PR…' : 'Yes, roll back'}
        </Button>
        <Button variant="ghost" size="sm" onClick={() => setOpen(false)} disabled={pending}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
