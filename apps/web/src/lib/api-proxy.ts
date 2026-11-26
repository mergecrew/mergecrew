/**
 * Pure helpers for the `/api/v1/*` → `${API_BASE_URL}/v1/*` proxy route
 * (`src/app/api/v1/[...path]/route.ts`). Kept free of Next.js imports so
 * they can be unit tested.
 */
import { clientIpFromHeaders } from './auth-cookies';

/**
 * Request headers forwarded to the API. Everything else — cookies, the
 * legacy `x-mergecrew-user-id` identity header, client-sent `x-forwarded-*`,
 * hop-by-hop headers — is dropped. The API authenticates only via
 * `Authorization`. `x-forwarded-for` is re-derived (see buildForwardHeaders).
 */
const FORWARDED_REQUEST_HEADERS = new Set([
  'accept',
  'accept-language',
  'authorization',
  'cache-control',
  'content-type',
  'if-match',
  'if-modified-since',
  'if-none-match',
  'last-event-id',
  'user-agent',
  'x-request-id',
]);

/** Response headers never relayed back to the browser (RFC 7230 hop-by-hop + length). */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'host',
  'content-length',
]);

/**
 * API paths (relative to `/v1/`) the proxy forwards without any
 * credentials. Everything else requires an `Authorization` header, either
 * supplied by the caller or synthesized from the session.
 */
const PUBLIC_PATH_PREFIXES = ['skills', 'lifecycle-templates/stock', 'notifications/unsubscribe'];

// Conservative per-segment charset: slugs, uuids, dates, file-ish names.
// Excludes `/`, `\`, `%` (no encoded separators / double-encoding) and
// anything control-ish.
const SAFE_SEGMENT_RE = /^[A-Za-z0-9._~:@!$&'()*+,;=-]+$/;

/**
 * Validate the catch-all segments and build the API path (without the
 * leading `/v1/`). Returns `null` for anything that could escape `/v1/`:
 * empty, `.` or `..` segments, or segments containing (encoded) slashes,
 * backslashes or percent signs.
 */
export function safeApiPath(segments: readonly string[]): string | null {
  if (segments.length === 0) return null;
  for (const seg of segments) {
    if (!seg || seg === '.' || seg === '..') return null;
    if (!SAFE_SEGMENT_RE.test(seg)) return null;
  }
  return segments.map((s) => encodeURIComponent(s)).join('/');
}

export function isPublicApiPath(apiPath: string): boolean {
  return PUBLIC_PATH_PREFIXES.some((p) => apiPath === p || apiPath.startsWith(`${p}/`));
}

/**
 * Copy only allowlisted request headers, then add the client address as a
 * single-entry `x-forwarded-for` (same derivation as `lib/api.ts`) so the
 * API's per-IP rate limits key on the browser rather than the web
 * container. The client's own forwarding headers are never relayed as-is.
 */
export function buildForwardHeaders(incoming: Headers): Headers {
  const out = new Headers();
  incoming.forEach((value, key) => {
    if (FORWARDED_REQUEST_HEADERS.has(key.toLowerCase())) out.set(key, value);
  });
  const ip = clientIpFromHeaders(incoming);
  if (ip) out.set('x-forwarded-for', ip);
  return out;
}

/** Copy upstream response headers minus hop-by-hop ones. */
export function buildResponseHeaders(upstream: Headers): Headers {
  const out = new Headers();
  upstream.forEach((value, key) => {
    if (!HOP_BY_HOP.has(key.toLowerCase())) out.set(key, value);
  });
  return out;
}
