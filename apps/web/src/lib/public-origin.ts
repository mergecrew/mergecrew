import type { NextRequest } from 'next/server';

/**
 * Resolve the public origin to redirect to. Behind a reverse proxy,
 * `req.url` reflects the internal container hostname (e.g.
 * `https://121048555ff3:3000`), which leaks into the redirect Location
 * and breaks the click-through. Preference order:
 *   1. WEB_BASE_URL env var (explicit, set in compose / prod env).
 *   2. X-Forwarded-Host + X-Forwarded-Proto headers (most proxies set
 *      these; safe fallback when WEB_BASE_URL isn't configured).
 *   3. req.url's own origin (local dev — no proxy in front).
 *
 * Shared by every Next.js route handler that needs to emit absolute
 * redirects back to the user's browser (#1 magic-link callback,
 * #457 GitHub install BFF, …).
 */
export function publicOrigin(req: NextRequest | Request): string {
  if (process.env.WEB_BASE_URL) return process.env.WEB_BASE_URL;
  const fwdHost = req.headers.get('x-forwarded-host');
  if (fwdHost) {
    const fwdProto = req.headers.get('x-forwarded-proto') ?? 'https';
    return `${fwdProto}://${fwdHost}`;
  }
  return new URL(req.url).origin;
}
