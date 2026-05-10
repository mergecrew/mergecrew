'use server';

const API_BASE = process.env.API_BASE_URL ?? 'http://localhost:4000';

/**
 * Web-public-base URL used to build the magic-link callback the email
 * lands on. Defaults to the request origin in dev; override in
 * production via WEB_BASE_URL.
 */
function publicCallbackUrl(): string {
  const base = process.env.WEB_BASE_URL ?? 'http://localhost:3000';
  return `${base.replace(/\/+$/, '')}/api/auth/magic-link`;
}

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
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, callbackUrl: publicCallbackUrl() }),
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
    return { ok: true, email };
  } catch (e: any) {
    return { ok: false, error: String(e?.message ?? e) };
  }
}
