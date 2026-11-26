import Link from 'next/link';
import { api } from '@/lib/api';
import { requireSession } from '@/lib/session';
import { Button, Card, RolePill } from '@/components/ui';
import { acceptInvitation, declineInvitation } from './actions';

export const dynamic = 'force-dynamic';

interface Invitation {
  id: string;
  role: 'owner' | 'admin' | 'operator' | 'viewer';
  expiresAt: string;
  organization: { slug: string; name: string };
}

/**
 * Invitations addressed to the signed-in user's email. Nothing is joined
 * until the user accepts here.
 */
export default async function InvitationsPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const session = await requireSession();
  const sp = await searchParams;
  const res = await api<{ items: Invitation[] }>('/v1/me/invitations', { session }).catch(() => ({
    items: [] as Invitation[],
  }));

  return (
    <main className="mx-auto max-w-2xl space-y-4 p-6">
      <header>
        <h1 className="text-xl font-semibold">Invitations</h1>
        <p className="text-sm text-zinc-500">
          Organizations that invited {session.email}. You only join after accepting.
        </p>
      </header>
      {sp.error && (
        <div className="border border-energy bg-energy-soft px-3 py-2 text-[13px] text-energy-deep">
          That invitation could not be accepted. It may have expired or been revoked.
        </div>
      )}
      <Card>
        {res.items.length === 0 ? (
          <div className="p-5 text-[13px] text-muted">
            No pending invitations. <Link href="/">Back to Mergecrew</Link>
          </div>
        ) : (
          <ul className="m-0 list-none p-0">
            {res.items.map((inv, i) => (
              <li
                key={inv.id}
                className={
                  'grid grid-cols-[1fr_auto_auto_auto] items-center gap-3 px-5 py-4 text-[13px] ' +
                  (i < res.items.length - 1 ? 'border-b border-hair-2' : '')
                }
              >
                <div className="min-w-0">
                  <div className="text-[14px] font-medium">{inv.organization.name}</div>
                  <div className="font-mono text-[11.5px] text-muted">/{inv.organization.slug}</div>
                </div>
                <RolePill role={inv.role} />
                <form action={acceptInvitation}>
                  <input type="hidden" name="id" value={inv.id} />
                  <Button variant="accent" size="sm" type="submit">
                    Accept
                  </Button>
                </form>
                <form action={declineInvitation}>
                  <input type="hidden" name="id" value={inv.id} />
                  <Button variant="secondary" size="sm" type="submit">
                    Decline
                  </Button>
                </form>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </main>
  );
}
