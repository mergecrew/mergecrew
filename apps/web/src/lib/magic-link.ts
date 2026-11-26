import type { FirstFactorResult } from './login-cookies';

const API_BASE = () => process.env.API_BASE_URL ?? 'http://localhost:4000';

/**
 * Consume a magic-link token at the API. Returns the login result, or
 * an error code suitable for `/login?error=…`. Never surfaces the API
 * response body to the browser.
 */
export async function verifyMagicLink(
  email: string,
  token: string,
  forwardHeaders: Record<string, string> = {},
): Promise<{ ok: true; result: FirstFactorResult } | { ok: false; error: string }> {
  try {
    const r = await fetch(`${API_BASE()}/v1/auth/magic-link/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...forwardHeaders },
      body: JSON.stringify({ email, token }),
      cache: 'no-store',
    });
    if (r.status === 429) return { ok: false, error: 'rate_limited' };
    if (!r.ok) return { ok: false, error: 'invalid_or_expired' };
    return { ok: true, result: (await r.json()) as FirstFactorResult };
  } catch {
    return { ok: false, error: 'verify_failed' };
  }
}
