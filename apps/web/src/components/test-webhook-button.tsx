'use client';

import { useState, useTransition } from 'react';
import { Button } from '@/components/ui';

/**
 * Fires the passed server action that POSTs to the test endpoint, surfaces
 * a lightweight ack. The actual delivery happens async on the orchestrator
 * worker — operators check the deliveries log for the result.
 */
export function TestWebhookButton({
  onTest,
}: {
  onTest: () => Promise<{ ok: true } | { ok: false; error: string }>;
}) {
  const [pending, startTransition] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);

  return (
    <div className="flex items-center gap-2">
      {msg && <span className="text-xs text-zinc-500">{msg}</span>}
      <Button
        type="button"
        variant="secondary"
        disabled={pending}
        onClick={() =>
          startTransition(async () => {
            setMsg(null);
            const res = await onTest();
            setMsg(res.ok ? 'queued' : `failed: ${res.error}`);
          })
        }
      >
        {pending ? 'Testing…' : 'Send test'}
      </Button>
    </div>
  );
}
