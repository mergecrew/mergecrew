'use server';

import { cookies } from 'next/headers';
import {
  MAGIC_LINK_STATE_COOKIE,
  MAGIC_LINK_STATE_MAX_AGE_S,
  cookieOpts,
  normalizeEmail,
} from '@/lib/auth-cookies';
import { forwardedClientIpHeader } from '@/lib/session';
import { requestUsesSecureCookies } from '@/lib/server-cookies';

const API_BASE = process.env.API_BASE_URL ?? 'http://localhost:4000';

export async function requestMagicLink(formData: FormData): Promise<{
  ok: true;
  email: string;
} | {
  ok: false;
  error: string;
}> {
  const email = String(formData.get('email') ?? '').trim();
  if (!email) return { ok: false, error: 'enter an email' };

  try {
    const r = await fetch(`${API_BASE}/v1/auth/magic-link/request`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(await forwardedClientIpHeader()) },
      body: JSON.stringify({ email }),
      cache: 'no-store',
    });
    if (!r.ok) {
      let body: any = null;
      try {
        body = await r.json();
      } catch {}
      const msg = body?.error?.message ?? body?.error?.code ?? `HTTP ${r.status}`;
      return { ok: false, error: String(msg) };
    }
    // Same-browser marker: the emailed link signs in directly only from a
    // browser holding this cookie for the same address (see
    // app/api/auth/magic-link/route.ts).
    const c = await cookies();
    c.set(
      MAGIC_LINK_STATE_COOKIE,
      normalizeEmail(email),
      cookieOpts(MAGIC_LINK_STATE_MAX_AGE_S, await requestUsesSecureCookies()),
    );
    return { ok: true, email };
  } catch (e: any) {
    return { ok: false, error: String(e?.message ?? e) };
  }
}
