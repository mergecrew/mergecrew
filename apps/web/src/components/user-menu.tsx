import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { signOut } from '@/auth';
import { api } from '@/lib/api';
import { getSession, SIGNED_OUT_COOKIE } from '@/lib/session';
import { UserMenuDropdown } from './user-menu-dropdown';

type Org = { slug: string; name: string };

export async function UserMenu({ currentOrgSlug }: { currentOrgSlug?: string }) {
  const session = await getSession();
  if (!session) return null;
  const label = session.name ?? session.email;

  let orgs: Org[] = [];
  try {
    const res = await api<{ items: Org[] }>('/v1/orgs', { session });
    orgs = res.items ?? [];
  } catch {
    /* empty list — menu still renders */
  }

  const signOutSlot = (
    <form
      action={async () => {
        'use server';
        const c = await cookies();
        c.set(SIGNED_OUT_COOKIE, '1', {
          path: '/',
          httpOnly: true,
          sameSite: 'lax',
          maxAge: 60 * 60 * 24 * 30,
        });
        try {
          await signOut({ redirect: false });
        } catch {
          /* no NextAuth session in dev mode — ignore */
        }
        redirect('/');
      }}
    >
      <button
        type="submit"
        className="block w-full px-4 py-2 text-left text-sm hover:bg-zinc-100 dark:hover:bg-zinc-800"
      >
        Sign out
      </button>
    </form>
  );

  return (
    <UserMenuDropdown
      label={label}
      email={session.email}
      orgs={orgs}
      currentOrgSlug={currentOrgSlug}
      signOutSlot={signOutSlot}
    />
  );
}
