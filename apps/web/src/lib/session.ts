import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { getToken } from 'next-auth/jwt';
import type { Session } from './api';
import {
  JWT_OVERRIDE_COOKIE,
  MFA_PENDING_COOKIE,
  SIGNED_OUT_COOKIE,
  USER_OVERRIDE_COOKIE,
  clientIpFromHeaders,
} from './auth-cookies';
import { bffTrustToken } from './secrets';

/**
 * Cookie names re-exported for existing importers. See auth-cookies.ts.
 *
 * `mergecrew_jwt` overrides the session JWT when set. The magic-link,
 * MFA enrolment, and MFA challenge flows write to it so the (upgraded)
 * JWT is used for subsequent requests without bouncing through NextAuth.
 *
 * `mergecrew_user` carries the signed-in user profile (id/email/name)
 * for sessions minted outside NextAuth. When set alongside
 * `mergecrew_jwt`, `getSession()` returns that identity directly.
 */
export { JWT_OVERRIDE_COOKIE, USER_OVERRIDE_COOKIE, SIGNED_OUT_COOKIE, MFA_PENDING_COOKIE };

export function isDevAutoLogin(): boolean {
  const raw =
    process.env.MERGECREW_DEV_AUTO_LOGIN ??
    (process.env.NODE_ENV === 'production' ? 'false' : 'true');
  return raw === 'true';
}

function devUserEmail(): string {
  return process.env.MERGECREW_DEV_USER_EMAIL ?? 'demo@mergecrew.local';
}

function devUserName(): string {
  return process.env.MERGECREW_DEV_USER_NAME ?? 'Demo User';
}

let cachedDevSession: Session | null = null;

/** Drop the cached dev auto-login session (its JWT is revoked on sign-out). */
export function resetDevSessionCache(): void {
  cachedDevSession = null;
}

async function devExchange(): Promise<Session | null> {
  if (cachedDevSession) return cachedDevSession;
  try {
    const email = devUserEmail();
    const name = devUserName();
    const r = await fetch(
      `${process.env.API_BASE_URL ?? 'http://localhost:4000'}/v1/auth/exchange`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          email,
          name,
          trustToken: bffTrustToken(),
        }),
        cache: 'no-store',
      },
    );
    if (!r.ok) return null;
    const j = (await r.json()) as { token?: string; user: { id: string } };
    // An MFA-enrolled demo user gets no auto-login session.
    if (!j.token) return null;
    cachedDevSession = { userId: j.user.id, email, name, jwt: j.token };
    return cachedDevSession;
  } catch {
    return null;
  }
}

async function isManuallySignedOut(): Promise<boolean> {
  const c = await cookies();
  return c.get(SIGNED_OUT_COOKIE)?.value === '1';
}

async function jwtOverride(): Promise<string | null> {
  const c = await cookies();
  return c.get(JWT_OVERRIDE_COOKIE)?.value ?? null;
}

async function userOverride(): Promise<{ userId: string; email: string; name?: string } | null> {
  const c = await cookies();
  const raw = c.get(USER_OVERRIDE_COOKIE)?.value;
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { id?: string; email?: string; name?: string | null };
    if (!parsed.id || !parsed.email) return null;
    return {
      userId: parsed.id,
      email: parsed.email,
      ...(parsed.name ? { name: parsed.name } : {}),
    };
  } catch {
    return null;
  }
}

interface NextAuthToken {
  email?: string | null;
  name?: string | null;
  mergecrewJwt?: string;
  mergecrewMfaToken?: string;
  mergecrewUserId?: string;
}

/**
 * Decode NextAuth's encrypted session cookie on the server. The API JWT
 * is stored there (not in the session object served to the browser), so
 * this is the only way to read it. Tries the `__Secure-` cookie name
 * first, then the plain one.
 */
async function readNextAuthToken(): Promise<NextAuthToken | null> {
  const secret = process.env.AUTH_SECRET ?? process.env.NEXTAUTH_SECRET;
  if (!secret) return null;
  let cookie = '';
  try {
    cookie = (await headers()).get('cookie') ?? '';
  } catch {
    return null;
  }
  if (!cookie.includes('authjs.session-token')) return null;
  // Only the cookie header — never let a client-supplied Authorization
  // header stand in for the session cookie.
  const req = { headers: new Headers({ cookie }) };
  for (const secureCookie of [true, false]) {
    try {
      const t = await getToken({ req, secret, secureCookie });
      if (t) return t as NextAuthToken;
    } catch {
      /* try the other cookie name */
    }
  }
  return null;
}

export async function getSession(): Promise<Session | null> {
  if (await isManuallySignedOut()) return null;
  const override = await jwtOverride();
  const userOv = await userOverride();
  if (isDevAutoLogin()) {
    const base = await devExchange();
    if (!base) return null;
    return override ? { ...base, jwt: override } : base;
  }
  // Magic-link / MFA-completed flow: we have a JWT + user cookie set by
  // the BFF. That's a complete session on its own — bypass NextAuth.
  if (override && userOv) {
    return { userId: userOv.userId, email: userOv.email, name: userOv.name, jwt: override };
  }
  const t = await readNextAuthToken();
  if (!t?.email || !t.mergecrewUserId) return null;
  const jwt = override ?? t.mergecrewJwt;
  // No API JWT means the OAuth sign-in is still waiting on MFA.
  if (!jwt) return null;
  return {
    userId: t.mergecrewUserId,
    email: t.email,
    name: t.name ?? undefined,
    jwt,
  };
}

export interface PendingMfa {
  /** Pre-MFA API token, accepted only by POST /v1/me/mfa/challenge. */
  token: string;
  user: { id: string; email: string; name: string | null };
  source: 'magic-link' | 'oauth';
}

/**
 * The first factor has been proven but the TOTP challenge is still
 * outstanding (magic-link cookie, or an OAuth sign-in whose exchange
 * answered `mfaRequired`).
 */
export async function getPendingMfa(): Promise<PendingMfa | null> {
  const c = await cookies();
  const raw = c.get(MFA_PENDING_COOKIE)?.value;
  if (raw) {
    try {
      const p = JSON.parse(raw) as { t?: string; u?: { id?: string; email?: string; name?: string | null } };
      if (p.t && p.u?.id && p.u.email) {
        return { token: p.t, user: { id: p.u.id, email: p.u.email, name: p.u.name ?? null }, source: 'magic-link' };
      }
    } catch {
      /* fall through */
    }
  }
  const t = await readNextAuthToken();
  if (t?.mergecrewMfaToken && !t.mergecrewJwt && t.mergecrewUserId && t.email) {
    return {
      token: t.mergecrewMfaToken,
      user: { id: t.mergecrewUserId, email: t.email, name: t.name ?? null },
      source: 'oauth',
    };
  }
  return null;
}

/** Browser address to forward on server-side calls to auth endpoints. */
export async function forwardedClientIpHeader(): Promise<Record<string, string>> {
  try {
    const ip = clientIpFromHeaders(await headers());
    return ip ? { 'x-forwarded-for': ip } : {};
  } catch {
    return {};
  }
}

export async function requireSession(): Promise<Session> {
  const s = await getSession();
  if (!s) {
    // Log before bouncing so operators can audit "returning users
    // who got bounced because their session expired" vs "users who
    // just walked up to a protected page". Reason is derived from
    // cookies — manual sign-out and stale JWT are distinguishable
    // signals and we want to see both rates separately.
    //
    // No refresh-token rotation today (API JWT TTL is 14d). If the
    // stale_jwt count climbs, that's the case for adding one.
    let pendingMfa = false;
    try {
      const c = await cookies();
      const hadJwt = !!c.get(JWT_OVERRIDE_COOKIE)?.value;
      const signedOut = c.get(SIGNED_OUT_COOKIE)?.value === '1';
      pendingMfa = !signedOut && (await getPendingMfa()) !== null;
      const reason = signedOut
        ? 'manual_signout'
        : pendingMfa
          ? 'mfa_pending'
          : hadJwt
            ? 'stale_jwt'
            : 'no_session';
      console.warn(
        JSON.stringify({
          event: 'session.expired_redirect',
          reason,
          ts: new Date().toISOString(),
        }),
      );
    } catch {
      // cookies() throws when called outside a request scope (build,
      // background task). The redirect is still right to do; just
      // skip the log line.
    }
    // Returning users whose session has expired land here. Throwing
    // an Error renders Next's generic "A server error occurred" page,
    // which is both scary and a dead-end — they have no way back to
    // sign in. redirect() throws an internal NEXT_REDIRECT that Next
    // handles for both server components and server actions, so this
    // function's signature stays `Promise<Session>` for callers.
    redirect(pendingMfa ? '/login/mfa' : '/login');
  }
  return s;
}
