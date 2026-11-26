import { createHash, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';

/**
 * Access policy for the Prometheus `/metrics` exposition.
 *
 * Served only when either:
 *   - `METRICS_TOKEN` is set and the request carries
 *     `Authorization: Bearer <METRICS_TOKEN>`, or
 *   - the TCP peer is a loopback / private-network address AND the
 *     request carries no reverse-proxy forwarding headers. A request
 *     relayed by a reverse proxy (Caddy, nginx, an ingress) arrives from
 *     a private peer address but on behalf of an arbitrary client, so
 *     the presence of `X-Forwarded-For` / `Forwarded` / `X-Real-IP`
 *     disqualifies the private-network path.
 *
 * Uses the raw socket address, never `req.ip`, so a `trust proxy`
 * setting can't turn a client-supplied header into an internal address.
 * Everything else gets a 404 so the endpoint's existence isn't advertised.
 */
export interface MetricsRequestLike {
  headers: Record<string, string | string[] | undefined>;
  socket?: { remoteAddress?: string | undefined } | null;
}

const FORWARDING_HEADERS = ['x-forwarded-for', 'forwarded', 'x-real-ip', 'x-forwarded-host'];

export function isMetricsRequestAllowed(
  req: MetricsRequestLike,
  env: Record<string, string | undefined> = process.env,
): boolean {
  const token = (env.METRICS_TOKEN ?? '').trim();
  if (token) {
    const auth = headerValue(req.headers.authorization);
    if (auth?.startsWith('Bearer ') && safeEqual(auth.slice(7).trim(), token)) return true;
  }
  if (FORWARDING_HEADERS.some((h) => req.headers[h] !== undefined)) return false;
  return isPrivateAddress(req.socket?.remoteAddress);
}

export function isPrivateAddress(raw: string | undefined): boolean {
  if (!raw) return false;
  let addr = raw.trim().toLowerCase();
  if (addr.startsWith('[') && addr.endsWith(']')) addr = addr.slice(1, -1);
  const zone = addr.indexOf('%');
  if (zone !== -1) addr = addr.slice(0, zone);
  if (addr.startsWith('::ffff:') && isIP(addr.slice(7)) === 4) addr = addr.slice(7);

  const family = isIP(addr);
  if (family === 4) {
    const parts = addr.split('.').map(Number);
    const [a, b] = parts as [number, number];
    return (
      a === 10 ||
      a === 127 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254) ||
      (a === 100 && b >= 64 && b <= 127) // CGNAT / Tailscale-style overlay
    );
  }
  if (family === 6) {
    if (addr === '::1') return true;
    const first = parseInt(addr.split(':')[0] || '0', 16);
    return (first & 0xfe00) === 0xfc00 /* fc00::/7 ULA */ || (first & 0xffc0) === 0xfe80; /* fe80::/10 */
  }
  return false;
}

function headerValue(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

function safeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}
