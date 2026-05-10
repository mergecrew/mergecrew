import { api } from '@/lib/api';
import { requireSession } from '@/lib/session';
import { Card } from '@/components/ui';
import { MfaPanel } from './mfa-panel';

interface MfaStatus {
  enrolled: boolean;
  enrolledAt: string | null;
  pending: boolean;
  recoveryCodesRemaining: number;
}

export default async function AccountSecurityPage() {
  const session = await requireSession();
  const status = await api<MfaStatus>('/v1/me/mfa', { session });

  // If the user has a pending (un-verified) MFA setup, recover the
  // otpauth URL + render the QR server-side. Without this, refreshing
  // the page mid-enrollment would leave the user with the verify form
  // but no QR to scan — exactly the bug we're fixing.
  let pendingSetup: { qrDataUrl: string; otpauthUrl: string } | null = null;
  if (status.pending && !status.enrolled) {
    try {
      const r = await api<{ otpauthUrl: string }>('/v1/me/mfa/setup', {
        method: 'POST',
        body: JSON.stringify({}),
        session,
      });
      const QRCode = (await import('qrcode')).default;
      const qrDataUrl = await QRCode.toDataURL(r.otpauthUrl, { margin: 1, width: 240 });
      pendingSetup = { otpauthUrl: r.otpauthUrl, qrDataUrl };
    } catch {
      // Best-effort. If the recovery fetch fails, the panel still renders the
      // verify form; the user can hit "Restart setup" to rotate.
    }
  }

  return (
    <main className="mx-auto max-w-2xl space-y-4 p-6">
      <header>
        <h1 className="text-xl font-semibold">Account security</h1>
        <p className="text-sm text-zinc-500">
          Two-factor authentication for {session.email}.
        </p>
      </header>

      <Card>
        <MfaPanel status={status} pendingSetup={pendingSetup} />
      </Card>
    </main>
  );
}
