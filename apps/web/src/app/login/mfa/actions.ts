'use server';

import { redirect } from 'next/navigation';
import { signOut } from '@/auth';
import { forwardedClientIpHeader, getPendingMfa } from '@/lib/session';
import { loginCookieWrites, signOutCookieWrites } from '@/lib/login-cookies';
import { applyCookieWrites, requestUsesSecureCookies } from '@/lib/server-cookies';

const API_BASE = () => process.env.API_BASE_URL ?? 'http://localhost:4000';

/**
 * Finish an MFA-gated sign-in: trade the pre-MFA token + a TOTP (or
 * recovery code) for a full session at /v1/me/mfa/challenge, then set
 * the session cookies. Works for both magic-link and OAuth sign-ins.
 */
export async function completeMfaSignIn(formData: FormData): Promise<void> {
  const code = String(formData.get('code') ?? '').trim();
  const pending = await getPendingMfa();
  if (!pending) redirect('/login?error=invalid_or_expired');
  if (!code) redirect('/login/mfa?error=invalid');

  let next: string;
  try {
    const r = await fetch(`${API_BASE()}/v1/me/mfa/challenge`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${pending.token}`,
        ...(await forwardedClientIpHeader()),
      },
      body: JSON.stringify({ code }),
      cache: 'no-store',
    });
    if (r.status === 429) {
      next = '/login/mfa?error=locked';
    } else if (r.status === 401) {
      // Pre-MFA token expired or was revoked: start over.
      await applyCookieWrites(signOutCookieWrites(await requestUsesSecureCookies()));
      next = '/login?error=invalid_or_expired';
    } else if (!r.ok) {
      next = '/login/mfa?error=invalid';
    } else {
      const j = (await r.json()) as {
        token: string;
        user: { id: string; email: string; name: string | null };
      };
      await applyCookieWrites(
        loginCookieWrites({ token: j.token, user: j.user }, await requestUsesSecureCookies()),
      );
      next = '/';
    }
  } catch {
    next = '/login/mfa?error=failed';
  }
  redirect(next);
}

/** Abandon the challenge and return to the sign-in page. */
export async function cancelMfaSignIn(): Promise<void> {
  const pending = await getPendingMfa();
  await applyCookieWrites(signOutCookieWrites(await requestUsesSecureCookies()));
  if (pending?.source === 'oauth') {
    try {
      await signOut({ redirect: false });
    } catch {
      /* no NextAuth session */
    }
  }
  redirect('/login');
}
