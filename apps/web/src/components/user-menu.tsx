import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { signOut } from '@/auth';
import { api } from '@/lib/api';
import { getSession, isDevAutoLogin, resetDevSessionCache, SIGNED_OUT_COOKIE } from '@/lib/session';
import { cookieOpts } from '@/lib/auth-cookies';
import { signOutCookieWrites } from '@/lib/login-cookies';
import { applyCookieWrites, requestUsesSecureCookies } from '@/lib/server-cookies';
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
        // 1. Revoke server-side: bumps the user's token version so every
        //    outstanding API JWT (this browser and any copies) is rejected.
        const current = await getSession();
        if (current?.jwt) {
          try {
            await fetch(`${process.env.API_BASE_URL ?? 'http://localhost:4000'}/v1/auth/logout`, {
              method: 'POST',
              headers: { authorization: `Bearer ${current.jwt}` },
              cache: 'no-store',
            });
          } catch {
            /* API unreachable — still clear local state below */
          }
        }
        // 2. Delete the BFF session cookies rather than only flagging them.
        const secure = await requestUsesSecureCookies();
        await applyCookieWrites(signOutCookieWrites(secure));
        resetDevSessionCache();
        // 3. Dev auto-login needs a flag, or the demo user is re-minted on
        //    the next request.
        if (isDevAutoLogin()) {
          const c = await cookies();
          c.set(SIGNED_OUT_COOKIE, '1', { ...cookieOpts(60 * 60 * 24 * 30, secure) });
        }
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
        className="block w-full px-4 py-[7px] text-left text-[13px] text-energy-deep hover:bg-energy-soft"
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
