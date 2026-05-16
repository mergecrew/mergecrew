import { NextResponse, type NextRequest } from 'next/server';
import { JWT_OVERRIDE_COOKIE, USER_OVERRIDE_COOKIE } from '@/lib/session';

const API_BASE = process.env.API_BASE_URL ?? 'http://localhost:4000';

/**
 * Stale-session sweep. After a `docker compose down -v`, browsers still
 * carry the previous DB's `mergecrew_jwt` cookie — same JWT_SECRET so
 * it verifies, but the `sub` names a user that no longer exists. Left
 * alone, that JWT shadows the dev-auto-login user in `getSession()`
 * and any write that hits a `user_id` FK (e.g. `OrgService.create` →
 * `memberships_user_id_fkey`) explodes as a 500.
 *
 * We probe `/v1/auth/whoami` once per request that carries the cookie
 * and clear it (plus the paired user cookie) on a 401. Cheap indexed
 * user lookup on the API side; only authenticated-looking requests pay
 * the cost. On network blips we leave cookies in place so a transient
 * outage doesn't sign everyone out.
 */
export async function middleware(req: NextRequest) {
  const jwt = req.cookies.get(JWT_OVERRIDE_COOKIE)?.value;
  if (!jwt) return NextResponse.next();

  try {
    const r = await fetch(`${API_BASE}/v1/auth/whoami`, {
      method: 'GET',
      headers: { authorization: `Bearer ${jwt}` },
      cache: 'no-store',
    });
    if (r.status === 401) {
      // Strip from the inbound request so downstream `getSession()`
      // falls through to dev-auto-login (or NextAuth) on this same
      // request, instead of failing again with the same stale JWT.
      // Also wipe NextAuth's state cookies — a teardown that leaves
      // mergecrew_jwt stale typically also leaves a half-consumed
      // pkce_code_verifier behind, which surfaces as `[auth][error]
      // InvalidCheck` on the next OAuth attempt.
      const stale = [JWT_OVERRIDE_COOKIE, USER_OVERRIDE_COOKIE];
      for (const c of req.cookies.getAll()) {
        if (c.name.startsWith('next-auth.') || c.name.startsWith('__Secure-next-auth.')) {
          stale.push(c.name);
        }
      }
      for (const name of stale) req.cookies.delete(name);
      const res = NextResponse.next({ request: req });
      for (const name of stale) res.cookies.set(name, '', { path: '/', maxAge: 0 });
      return res;
    }
  } catch {
    // API unreachable — leave cookies, let downstream surface the error.
  }
  return NextResponse.next();
}

export const config = {
  // Run on app routes; skip static assets, Next internals, and the auth
  // callback routes (magic-link sets cookies inside its own handler and
  // shouldn't be intercepted mid-flight).
  matcher: ['/((?!_next/|api/auth/|favicon\\.ico|.*\\.(?:png|jpg|jpeg|svg|webp|ico)$).*)'],
};
