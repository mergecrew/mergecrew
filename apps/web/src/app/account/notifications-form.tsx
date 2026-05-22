'use client';

import { useState, useTransition } from 'react';
import { ToggleRow } from '@/components/ui';
import { setEmailDigestEnabledAction } from './notifications-actions';

export function NotificationsForm({
  initialEmailDigestEnabled,
}: {
  initialEmailDigestEnabled: boolean;
}) {
  const [enabled, setEnabled] = useState(initialEmailDigestEnabled);
  const [pending, startTransition] = useTransition();

  const setTo = (next: boolean) => {
    if (pending) return;
    setEnabled(next);
    startTransition(async () => {
      try {
        await setEmailDigestEnabledAction(next);
      } catch {
        // Revert on failure.
        setEnabled(!next);
      }
    });
  };

  return (
    <div className="space-y-3">
      <ToggleRow
        label="Daily digest email"
        desc={
          <>
            Receive the end-of-working-hours digest by email — one per project per day,
            covering active changesets, blocked items, and anomaly highlights. Off by
            default. SMTP / Resend must also be configured at the install level.
          </>
        }
        value={enabled}
        onChange={setTo}
      />
      <p className="m-0 text-[12px] text-muted">
        Slack delivery is configured at the org level under{' '}
        <span className="font-mono text-[12px] text-ink">Org settings → Slack</span>.
      </p>
    </div>
  );
}
