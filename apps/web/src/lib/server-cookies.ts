import { cookies, headers } from 'next/headers';
import { shouldUseSecureCookies } from './auth-cookies';
import type { CookieWrite } from './login-cookies';

/**
 * Whether cookies set from a server action / component must be Secure:
 * WEB_BASE_URL wins; otherwise the proxy's X-Forwarded-Proto; otherwise
 * true in production.
 */
export async function requestUsesSecureCookies(): Promise<boolean> {
  if (process.env.WEB_BASE_URL) return shouldUseSecureCookies(process.env.WEB_BASE_URL);
  try {
    const proto = (await headers()).get('x-forwarded-proto')?.split(',')[0]?.trim();
    if (proto) return proto === 'https';
  } catch {
    /* no request scope */
  }
  return shouldUseSecureCookies(null);
}

/** Apply cookie writes from a server action (cookies() is writable there). */
export async function applyCookieWrites(writes: CookieWrite[]): Promise<void> {
  const c = await cookies();
  for (const w of writes) c.set(w.name, w.value, w.opts);
}
