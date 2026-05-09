'use server';

import { cookies } from 'next/headers';
import { revalidatePath } from 'next/cache';
import { api } from '@/lib/api';
import { JWT_OVERRIDE_COOKIE, requireSession } from '@/lib/session';

const JWT_COOKIE_OPTS = {
  path: '/',
  httpOnly: true,
  sameSite: 'lax' as const,
  // Mirror the API JWT TTL (signOptions.expiresIn = '14d' on AuthModule).
  maxAge: 60 * 60 * 24 * 14,
};

async function setJwtOverride(token: string): Promise<void> {
  const c = await cookies();
  c.set(JWT_OVERRIDE_COOKIE, token, JWT_COOKIE_OPTS);
}

async function clearJwtOverride(): Promise<void> {
  const c = await cookies();
  c.set(JWT_OVERRIDE_COOKIE, '', { ...JWT_COOKIE_OPTS, maxAge: 0 });
}

export interface MfaSetupResult {
  ok: true;
  otpauthUrl: string;
  qrDataUrl: string;
}

export interface MfaActionError {
  ok: false;
  error: string;
}

export async function startSetup(): Promise<MfaSetupResult | MfaActionError> {
  try {
    const session = await requireSession();
    const r = await api<{ otpauthUrl: string; secret: string }>(
      '/v1/me/mfa/setup',
      { method: 'POST', body: JSON.stringify({}), session },
    );
    // Render the QR server-side so the client just gets a data URL — keeps
    // the 'qrcode' lib out of the bundled client JS.
    const QRCode = (await import('qrcode')).default;
    const qrDataUrl = await QRCode.toDataURL(r.otpauthUrl, { margin: 1, width: 240 });
    return { ok: true, otpauthUrl: r.otpauthUrl, qrDataUrl };
  } catch (e: any) {
    return { ok: false, error: String(e?.message ?? e) };
  }
}

export interface MfaVerifyResult {
  ok: true;
  recoveryCodes: string[];
}

export async function verify(code: string): Promise<MfaVerifyResult | MfaActionError> {
  try {
    const session = await requireSession();
    const r = await api<{ recoveryCodes: string[]; token: string }>(
      '/v1/me/mfa/verify',
      { method: 'POST', body: JSON.stringify({ code }), session },
    );
    await setJwtOverride(r.token);
    revalidatePath('/account/security');
    return { ok: true, recoveryCodes: r.recoveryCodes };
  } catch (e: any) {
    return { ok: false, error: String(e?.message ?? e) };
  }
}

export async function disable(code: string): Promise<{ ok: true } | MfaActionError> {
  try {
    const session = await requireSession();
    await api('/v1/me/mfa/disable', {
      method: 'POST',
      body: JSON.stringify({ code }),
      session,
    });
    await clearJwtOverride();
    revalidatePath('/account/security');
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: String(e?.message ?? e) };
  }
}

export interface RegenerateResult {
  ok: true;
  recoveryCodes: string[];
}

export async function regenerateRecoveryCodes(
  code: string,
): Promise<RegenerateResult | MfaActionError> {
  try {
    const session = await requireSession();
    const r = await api<{ recoveryCodes: string[] }>(
      '/v1/me/mfa/recovery-codes/regenerate',
      { method: 'POST', body: JSON.stringify({ code }), session },
    );
    revalidatePath('/account/security');
    return { ok: true, recoveryCodes: r.recoveryCodes };
  } catch (e: any) {
    return { ok: false, error: String(e?.message ?? e) };
  }
}

export async function challenge(code: string): Promise<{ ok: true } | MfaActionError> {
  try {
    const session = await requireSession();
    const r = await api<{ token: string; kind: 'totp' | 'recovery' }>(
      '/v1/me/mfa/challenge',
      { method: 'POST', body: JSON.stringify({ code }), session },
    );
    await setJwtOverride(r.token);
    revalidatePath('/account/security');
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: String(e?.message ?? e) };
  }
}
