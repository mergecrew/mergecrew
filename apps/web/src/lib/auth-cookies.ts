/**
 * Cookie names + attributes for the BFF's own session cookies. Kept free
 * of Next.js imports so it can be unit-tested and shared by route
 * handlers, server actions, and the edge middleware.
 */

/** API session JWT (httpOnly). Set by magic-link, MFA challenge/enrol. */
export const JWT_OVERRIDE_COOKIE = 'mergecrew_jwt';
/** Signed-in profile (id/email/name) paired with `mergecrew_jwt`. */
export const USER_OVERRIDE_COOKIE = 'mergecrew_user';
/** Dev auto-login "I signed out" flag. */
export const SIGNED_OUT_COOKIE = 'mergecrew_signed_out';
/**
 * Pre-MFA state for magic-link sign-ins: the short-lived API token that
 * is only accepted by /v1/me/mfa/challenge, plus the profile to show on
 * the challenge page. Never a session on its own.
 */
export const MFA_PENDING_COOKIE = 'mergecrew_mfa_pending';
/**
 * Same-browser marker written when a magic link is requested. The link's
 * callback signs in directly only when the marker matches the link's
 * email; otherwise the user must confirm on an interstitial page, so a
 * link minted for someone else's account cannot silently sign this
 * browser in.
 */
export const MAGIC_LINK_STATE_COOKIE = 'mergecrew_ml_state';

/** Mirrors the API JWT TTL (signOptions.expiresIn = '14d'). */
export const SESSION_MAX_AGE_S = 60 * 60 * 24 * 14;
/** Mirrors the API pre-MFA token TTL. */
export const MFA_PENDING_MAX_AGE_S = 10 * 60;
/** Mirrors the API magic-link token TTL. */
export const MAGIC_LINK_STATE_MAX_AGE_S = 15 * 60;

/**
 * Whether cookies must carry `Secure`. True when the public origin is
 * https; when the origin is unknown, true in production. Plain-http
 * localhost trial stacks keep working because their origin is http.
 */
export function shouldUseSecureCookies(
  origin?: string | null,
  env: { WEB_BASE_URL?: string; NODE_ENV?: string } = process.env,
): boolean {
  const o = origin || env.WEB_BASE_URL;
  if (o) return o.trim().toLowerCase().startsWith('https://');
  return env.NODE_ENV === 'production';
}

export interface CookieOpts {
  path: string;
  httpOnly: boolean;
  sameSite: 'lax';
  secure: boolean;
  maxAge: number;
}

export function cookieOpts(maxAge: number, secure: boolean): CookieOpts {
  return { path: '/', httpOnly: true, sameSite: 'lax', secure, maxAge };
}

/** Attributes that expire a cookie immediately. */
export function expiredCookieOpts(secure: boolean): CookieOpts {
  return cookieOpts(0, secure);
}

/** Normalise an email for marker comparison. */
export function normalizeEmail(e: string | null | undefined): string {
  return String(e ?? '').trim().toLowerCase();
}

/** True when the request carries the marker for exactly this email. */
export function magicLinkMarkerMatches(marker: string | null | undefined, email: string | null | undefined): boolean {
  const a = normalizeEmail(marker);
  return a.length > 0 && a === normalizeEmail(email);
}

/**
 * Rightmost X-Forwarded-For entry — the address appended by the single
 * trusted proxy (Caddy) in front of the web tier. Falls back to
 * X-Real-IP. Returns null when neither is present (local dev).
 */
export function clientIpFromHeaders(h: { get(name: string): string | null }): string | null {
  const xff = h.get('x-forwarded-for');
  if (xff) {
    const parts = xff.split(',').map((s) => s.trim()).filter(Boolean);
    const last = parts[parts.length - 1];
    if (last && last.length <= 64) return last;
  }
  const real = h.get('x-real-ip')?.trim();
  if (real && real.length <= 64) return real;
  return null;
}
