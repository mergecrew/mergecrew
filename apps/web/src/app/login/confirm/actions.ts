'use server';

import { redirect } from 'next/navigation';
import { forwardedClientIpHeader } from '@/lib/session';
import { loginCookieWrites, postLoginPath } from '@/lib/login-cookies';
import { verifyMagicLink } from '@/lib/magic-link';
import { applyCookieWrites, requestUsesSecureCookies } from '@/lib/server-cookies';

/**
 * Explicit confirmation for a magic link opened in a browser that did
 * not request it. Server actions are origin-checked by Next.js, so this
 * cannot be triggered cross-site.
 */
export async function confirmMagicLink(formData: FormData): Promise<void> {
  const email = String(formData.get('email') ?? '');
  const token = String(formData.get('token') ?? '');
  if (!email || !token) redirect('/login?error=missing_token');
  const v = await verifyMagicLink(email, token, await forwardedClientIpHeader());
  if (!v.ok) redirect(`/login?error=${v.error}`);
  await applyCookieWrites(loginCookieWrites(v.result, await requestUsesSecureCookies()));
  redirect(postLoginPath(v.result));
}
