import { cookies } from 'next/headers';
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

export async function getSession(): Promise<Session | null> {
  if (await isManuallySignedOut()) return null;
  const override = await jwtOverride();
  if (isDevAutoLogin()) {
    const base = await devExchange();
    if (!base) return null;
    return override ? { ...base, jwt: override } : base;
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
  if (!s) throw new Error('UNAUTHENTICATED');
  return s;
}
