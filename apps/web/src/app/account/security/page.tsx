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

  return (
    <main className="mx-auto max-w-2xl space-y-4 p-6">
      <header>
        <h1 className="text-xl font-semibold">Account security</h1>
        <p className="text-sm text-zinc-500">
          Two-factor authentication for {session.email}.
        </p>
      </header>

      <Card>
        <MfaPanel status={status} />
      </Card>
    </main>
  );
}
