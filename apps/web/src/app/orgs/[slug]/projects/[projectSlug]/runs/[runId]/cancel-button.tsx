'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui';
import { cancelRunAction } from './actions';

const CANCELLABLE_STATUSES = new Set([
  'pending',
  'running',
  'paused_rate_limit',
  'paused_gate',
  'paused_budget',
]);

export function ForceCancelButton({
  slug,
  projectSlug,
  runId,
  status,
}: {
  slug: string;
  projectSlug: string;
  runId: string;
  status: string;
}) {
  const [pending, startTx] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  if (!CANCELLABLE_STATUSES.has(status)) return null;

  const onClick = () => {
    if (!confirm('Force-fail this run? Any in-flight agent step will be marked failed.')) return;
    setError(null);
    startTx(async () => {
      const r = await cancelRunAction(slug, projectSlug, runId);
      if (r.ok) router.refresh();
      else setError(r.error);
    });
  };

  return (
    <div className="flex flex-col items-end gap-1">
      <Button variant="secondary" disabled={pending} onClick={onClick}>
        Force-fail
      </Button>
      {error && <span className="text-[11px] text-rose-600">{error}</span>}
    </div>
  );
}
