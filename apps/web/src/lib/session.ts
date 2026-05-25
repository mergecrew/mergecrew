import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { auth } from '@/auth';
import type { Session } from './api';

export const SIGNED_OUT_COOKIE = 'mergecrew_signed_out';
/**
 * Cookie that overrides the session JWT when set. The MFA enrollment +
 * challenge flows write to it so the upgraded JWT (which carries `mfa_at`)
 * is used for subsequent server actions without bouncing through NextAuth
 * or the dev-mode exchange cache.
 */
export const JWT_OVERRIDE_COOKIE = 'mergecrew_jwt';
/**
 * Cookie carrying the signed-in user profile (id/email/name) for sessions
 * minted outside NextAuth — namely the magic-link flow (#1). When set
 * alongside `mergecrew_jwt`, `getSession()` returns the override identity
 * directly without going through NextAuth.
 */
export const USER_OVERRIDE_COOKIE = 'mergecrew_user';

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
          trustToken: process.env.BFF_TRUST_TOKEN ?? 'dev-trust-token',
        }),
        cache: 'no-store',
      },
    );
    if (!r.ok) return null;
    const j = (await r.json()) as { token: string; user: { id: string } };
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

export async function getSession(): Promise<Session | null> {
  if (await isManuallySignedOut()) return null;
  const override = await jwtOverride();
  const userOv = await userOverride();
  if (isDevAutoLogin()) {
    const base = await devExchange();
    if (!base) return null;
    return override ? { ...base, jwt: override } : base;
  }
  // Magic-link flow (#1): we have a JWT + user cookie set by the BFF
  // verify route. That's a complete session on its own — bypass NextAuth.
  if (override && userOv) {
    return { userId: userOv.userId, email: userOv.email, name: userOv.name, jwt: override };
  }
  const s = await auth();
  if (!s?.user?.email) return null;
  const baseJwt = (s as any).mergecrewJwt as string | undefined;
  return {
    userId: (s as any).mergecrewUserId,
    email: s.user.email,
    name: s.user.name ?? undefined,
    jwt: override ?? baseJwt!,
  };
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
    try {
      const c = await cookies();
      const hadJwt = !!c.get(JWT_OVERRIDE_COOKIE)?.value;
      const signedOut = c.get(SIGNED_OUT_COOKIE)?.value === '1';
      const reason = signedOut ? 'manual_signout' : hadJwt ? 'stale_jwt' : 'no_session';
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
    redirect('/login');
  }
  return s;
}
