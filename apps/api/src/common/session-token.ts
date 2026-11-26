import type { JwtService } from '@nestjs/jwt';

/**
 * Session JWT claims.
 *
 * - `sub`    user id
 * - `tv`     the user's `tokenVersion` at mint time. A mismatch with the
 *            current DB value means the session was revoked (sign-out).
 *            Tokens minted before this claim existed carry none and are
 *            treated as version 0.
 * - `mfa_at` Unix seconds of the last successful MFA challenge.
 * - `typ`    `mfa_pending` for the short-lived token issued to an
 *            MFA-enrolled user who has proven the first factor but not yet
 *            passed the TOTP challenge. Absent on full session tokens.
 */
export interface SessionClaims {
  sub: string;
  tv?: number;
  mfa_at?: number;
  typ?: string;
}

export const MFA_PENDING_TOKEN_TYPE = 'mfa_pending';
/** Lifetime of a pre-MFA token: long enough to open an authenticator app. */
export const MFA_PENDING_TOKEN_TTL = '10m';

/** The only route a pre-MFA token may call. */
export function isMfaChallengeRoute(method: string, path: string): boolean {
  return method.toUpperCase() === 'POST' && /^\/v1\/me\/mfa\/challenge\/?$/i.test(path);
}

export interface SessionUserRow {
  tokenVersion: number;
  mfaEnrolledAt: Date | null;
}

export type SessionCheckResult =
  | {
      ok: true;
      userId: string;
      mfaChallengedAt?: Date;
      mfaEnrolled: boolean;
      /** True when authenticated with a pre-MFA token (challenge route only). */
      mfaPending: boolean;
    }
  | { ok: false; code: string; message: string };

/**
 * Validate a user session bearer token. Shared by the API's auth
 * middleware (main.ts) and `/v1/auth/whoami` so every path applies the
 * same rules:
 *
 *  1. signature + expiry,
 *  2. the user still exists,
 *  3. `tv` matches the user's current token version (server-side revocation),
 *  4. a pre-MFA token is only accepted where `allowMfaPending` is set,
 *  5. an MFA-enrolled user's full session must carry `mfa_at`, so a session
 *     minted without passing the challenge (or before enrolment) is refused.
 */
export async function checkSessionToken(opts: {
  jwt: JwtService;
  token: string | undefined;
  loadUser: (userId: string) => Promise<SessionUserRow | null>;
  allowMfaPending?: boolean;
}): Promise<SessionCheckResult> {
  if (!opts.token) return { ok: false, code: 'UNAUTHORIZED', message: 'unauthorized' };
  let claims: SessionClaims;
  try {
    claims = opts.jwt.verify<SessionClaims>(opts.token);
  } catch {
    return { ok: false, code: 'UNAUTHORIZED', message: 'unauthorized' };
  }
  if (!claims || typeof claims.sub !== 'string' || !claims.sub) {
    return { ok: false, code: 'UNAUTHORIZED', message: 'unauthorized' };
  }
  const pending = claims.typ === MFA_PENDING_TOKEN_TYPE;
  if (claims.typ !== undefined && !pending) {
    return { ok: false, code: 'UNAUTHORIZED', message: 'unauthorized' };
  }
  if (pending && !opts.allowMfaPending) {
    return {
      ok: false,
      code: 'MFA_CHALLENGE_REQUIRED',
      message: 'complete the MFA challenge to finish signing in',
    };
  }

  let user: SessionUserRow | null;
  try {
    user = await opts.loadUser(claims.sub);
  } catch {
    // Malformed uuid in `sub` etc. — normalise to a stale session.
    user = null;
  }
  if (!user) {
    return {
      ok: false,
      code: 'STALE_SESSION',
      message: 'session user no longer exists — sign in again',
    };
  }
  if ((claims.tv ?? 0) !== user.tokenVersion) {
    return { ok: false, code: 'SESSION_REVOKED', message: 'session has been signed out — sign in again' };
  }
  const mfaEnrolled = user.mfaEnrolledAt !== null;
  if (!pending && mfaEnrolled && typeof claims.mfa_at !== 'number') {
    return {
      ok: false,
      code: 'MFA_CHALLENGE_REQUIRED',
      message: 'complete the MFA challenge to finish signing in',
    };
  }
  return {
    ok: true,
    userId: claims.sub,
    ...(typeof claims.mfa_at === 'number' ? { mfaChallengedAt: new Date(claims.mfa_at * 1000) } : {}),
    mfaEnrolled,
    mfaPending: pending,
  };
}
