import { NextResponse, type NextRequest } from 'next/server';
import { publicOrigin } from '@/lib/public-origin';
import {
  MAGIC_LINK_STATE_COOKIE,
  clientIpFromHeaders,
  magicLinkMarkerMatches,
  shouldUseSecureCookies,
} from '@/lib/auth-cookies';
import { loginCookieWrites, postLoginPath } from '@/lib/login-cookies';
import { verifyMagicLink } from '@/lib/magic-link';

/**
 * Magic-link callback (#1). The email contains a link to
 * /api/auth/magic-link?token=…&email=….
 *
 * The link only signs this browser in directly when it carries the
 * same-browser marker cookie set when the link was requested for that
 * email. Otherwise (a link opened on another device, or one minted for
 * a different account) the user is sent to /login/confirm, which shows
 * the account and requires an explicit, same-origin confirmation before
 * the token is consumed.
 *
 * On success we set the API session JWT as the override cookie, or — for
 * MFA-enrolled users — the short-lived pre-MFA cookie and redirect to the
 * TOTP challenge. The API endpoint is single-use: replays return 400. On
 * error we redirect to /login with an error query, never exposing the
 * API response body to the client.
 */
export async function GET(req: NextRequest) {
  const u = new URL(req.url);
  const token = u.searchParams.get('token');
  const email = u.searchParams.get('email');
  const origin = publicOrigin(req);

  if (!token || !email) {
    return NextResponse.redirect(new URL('/login?error=missing_token', origin));
  }

  if (!magicLinkMarkerMatches(req.cookies.get(MAGIC_LINK_STATE_COOKIE)?.value, email)) {
    const confirm = new URL('/login/confirm', origin);
    confirm.searchParams.set('email', email);
    confirm.searchParams.set('token', token);
    return NextResponse.redirect(confirm);
  }

  const ip = clientIpFromHeaders(req.headers);
  const v = await verifyMagicLink(email, token, ip ? { 'x-forwarded-for': ip } : {});
  if (!v.ok) {
    return NextResponse.redirect(new URL(`/login?error=${v.error}`, origin));
  }

  const res = NextResponse.redirect(new URL(postLoginPath(v.result), origin));
  for (const w of loginCookieWrites(v.result, shouldUseSecureCookies(origin))) {
    res.cookies.set(w.name, w.value, w.opts);
  }
  // Never let the token-bearing URL leak via Referer from the next page.
  res.headers.set('referrer-policy', 'no-referrer');
  return res;
}
