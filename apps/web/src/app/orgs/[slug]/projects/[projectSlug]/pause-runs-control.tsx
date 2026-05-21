'use client';

import { useState, useTransition } from 'react';
import { Button } from '@/components/ui';

/**
 * Operator kill switch (#625) — project-scope control.
 *
 * Renders Stop when active, Resume when paused. Stop opens an inline
 * reason panel; Resume is a one-click confirm. Both call server
 * actions passed as props so submission stays in the server-component
 * tree's auth/cookie context.
 */
export function PauseRunsControl({
  paused,
  pauseAction,
  resumeAction,
}: {
  paused: boolean;
  pauseAction: (reason: string | null) => Promise<{ ok: boolean; error?: string }>;
  resumeAction: () => Promise<{ ok: boolean; error?: string }>;
}) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  if (paused) {
    return (
      <Button
        variant="secondary"
        disabled={pending}
        onClick={() =>
          startTransition(async () => {
            const r = await resumeAction();
            if (!r.ok) setError(r.error ?? 'Failed to resume.');
          })
        }
      >
        {pending ? 'Resuming…' : 'Resume runs'}
      </Button>
    );
  }

  if (!open) {
    return (
      <Button variant="destructive" onClick={() => setOpen(true)}>
        Stop runs
      </Button>
    );
  }

  return (
    <div className="flex w-72 flex-col gap-2 rounded-md border border-red-200 bg-red-50 p-3 dark:border-red-800 dark:bg-red-900/20">
      <label className="text-xs font-medium text-red-900 dark:text-red-200">
        Why are you stopping runs? (optional)
      </label>
      <textarea
        className="w-full rounded border bg-white px-2 py-1 text-sm dark:bg-zinc-900 dark:border-zinc-700"
        rows={2}
        maxLength={500}
        placeholder="e.g. flaky agent, budget freeze, vendor outage"
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        disabled={pending}
      />
      {error && <div className="text-xs text-red-800 dark:text-red-300">{error}</div>}
      <div className="flex justify-end gap-2">
        <Button
          variant="ghost"
          onClick={() => {
            setOpen(false);
            setReason('');
            setError(null);
          }}
          disabled={pending}
        >
          Cancel
        </Button>
        <Button
          variant="destructive"
          disabled={pending}
          onClick={() =>
            startTransition(async () => {
              const r = await pauseAction(reason.trim() || null);
              if (r.ok) {
                setOpen(false);
                setReason('');
                setError(null);
              } else {
                setError(r.error ?? 'Failed to pause.');
              }
            })
          }
        >
          {pending ? 'Stopping…' : 'Stop runs'}
        </Button>
      </div>
    </div>
  );
}
