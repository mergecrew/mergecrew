'use client';

import { useState, useTransition } from 'react';
import { Button } from '@/components/ui';

export interface DeliveryRow {
  id: string;
  deliveryUuid: string;
  eventType: string;
  statusCode: number | null;
  attempt: number;
  occurredAt: string;
  errorMessage: string | null;
}

/**
 * Lazy-loaded delivery log for one webhook. Click "View deliveries" to
 * fetch the last 50 attempts; subsequent clicks toggle visibility without
 * refetching. Server action does the privileged GET via the BFF.
 */
export function WebhookDeliveriesLog({
  load,
}: {
  load: () => Promise<{ ok: true; items: DeliveryRow[] } | { ok: false; error: string }>;
}) {
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<DeliveryRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function toggle() {
    if (!open && rows === null) {
      startTransition(async () => {
        const r = await load();
        if (r.ok) {
          setRows(r.items);
          setError(null);
        } else {
          setError(r.error);
        }
        setOpen(true);
      });
      return;
    }
    setOpen((v) => !v);
  }

  return (
    <div className="space-y-2">
      <Button type="button" variant="ghost" onClick={toggle} disabled={pending}>
        {pending
          ? 'Loading…'
          : open
            ? 'Hide deliveries'
            : rows === null
              ? 'View deliveries'
              : 'Show deliveries'}
      </Button>
      {open && error && <p className="text-xs text-red-600 dark:text-red-400">{error}</p>}
      {open && rows && rows.length === 0 && (
        <p className="text-xs text-zinc-500">No deliveries yet.</p>
      )}
      {open && rows && rows.length > 0 && (
        <ul className="space-y-1 text-xs font-mono">
          {rows.map((r) => (
            <li
              key={r.id}
              className="flex flex-wrap items-baseline gap-2 rounded border border-zinc-200 px-2 py-1 dark:border-zinc-800"
            >
              <span className="text-zinc-500">
                {new Date(r.occurredAt).toLocaleTimeString()}
              </span>
              <span className="font-medium">{r.eventType}</span>
              <span
                className={
                  r.statusCode == null
                    ? 'rounded bg-zinc-100 px-1 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300'
                    : r.statusCode >= 200 && r.statusCode < 300
                      ? 'rounded bg-green-100 px-1 text-green-800 dark:bg-green-900/40 dark:text-green-200'
                      : 'rounded bg-red-100 px-1 text-red-700 dark:bg-red-900/40 dark:text-red-300'
                }
              >
                {r.statusCode == null ? 'no response' : r.statusCode}
              </span>
              <span className="text-zinc-500">attempt {r.attempt}</span>
              {r.errorMessage && (
                <span className="basis-full text-red-600 dark:text-red-400">{r.errorMessage}</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
