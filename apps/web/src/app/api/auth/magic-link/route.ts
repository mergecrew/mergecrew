import { NextResponse, type NextRequest } from 'next/server';
import { JWT_OVERRIDE_COOKIE, SIGNED_OUT_COOKIE, USER_OVERRIDE_COOKIE } from '@/lib/session';

const API_BASE = process.env.API_BASE_URL ?? 'http://localhost:4000';

const COOKIE_OPTS = {
  path: '/',
  httpOnly: true,
  sameSite: 'lax' as const,
  // Mirror the API JWT TTL (signOptions.expiresIn = '14d' on AuthModule).
  maxAge: 60 * 60 * 24 * 14,
};

/**
 * Resolve the public origin to redirect to. Behind a reverse proxy,
 * `req.url` reflects the internal container hostname (e.g.
 * `https://121048555ff3:3000`), which would leak into the redirect
 * Location and break the magic-link click-through. Preference order:
 *   1. WEB_BASE_URL env var (explicit, set in compose / prod env).
 *   2. X-Forwarded-Host + X-Forwarded-Proto headers (most proxies set
 *      these; safe fallback when WEB_BASE_URL isn't configured).
 *   3. req.url's own origin (local dev — no proxy in front).
 */
function publicOrigin(req: NextRequest): string {
  if (process.env.WEB_BASE_URL) return process.env.WEB_BASE_URL;
  const fwdHost = req.headers.get('x-forwarded-host');
  if (fwdHost) {
    const fwdProto = req.headers.get('x-forwarded-proto') ?? 'https';
    return `${fwdProto}://${fwdHost}`;
  }
  return new URL(req.url).origin;
}

/**
 * Magic-link callback (#1). The email contains a link to
 * /api/auth/magic-link?token=…&email=…. We POST to the API's verify
 * endpoint, which consumes the one-time token and returns a fresh
 * Mergecrew session JWT. We set that JWT as the override cookie so
 * `getSession()` sees a real signed-in user.
 *
 * The API endpoint is single-use: replays return 400. On error we
 * redirect to /login with an error query, never expose the API
 * response body to the client.
 */
export async function GET(req: NextRequest) {
  const u = new URL(req.url);
  const token = u.searchParams.get('token');
  const email = u.searchParams.get('email');
  const origin = publicOrigin(req);

  if (!token || !email) {
    return NextResponse.redirect(new URL('/login?error=missing_token', origin));
  }

  try {
    const r = await fetch(`${API_BASE}/v1/auth/magic-link/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, token }),
      cache: 'no-store',
    });
    if (!r.ok) {
      return NextResponse.redirect(new URL('/login?error=invalid_or_expired', origin));
    }
    const j = (await r.json()) as {
      token: string;
      user: { id: string; email: string; name: string | null };
    };

    const res = NextResponse.redirect(new URL('/', origin));
    res.cookies.set(JWT_OVERRIDE_COOKIE, j.token, COOKIE_OPTS);
    res.cookies.set(USER_OVERRIDE_COOKIE, JSON.stringify(j.user), COOKIE_OPTS);
    // Clear the manual sign-out cookie if present, so devs hopping between
    // login states don't get bounced back to a "Signed out" screen.
    res.cookies.set(SIGNED_OUT_COOKIE, '', { ...COOKIE_OPTS, maxAge: 0 });
    return res;
  } catch {
    return NextResponse.redirect(new URL('/login?error=verify_failed', origin));
  }
}
