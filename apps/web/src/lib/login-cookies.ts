import {
  JWT_OVERRIDE_COOKIE,
  MAGIC_LINK_STATE_COOKIE,
  MFA_PENDING_COOKIE,
  MFA_PENDING_MAX_AGE_S,
  SESSION_MAX_AGE_S,
  SIGNED_OUT_COOKIE,
  USER_OVERRIDE_COOKIE,
  cookieOpts,
  expiredCookieOpts,
  type CookieOpts,
} from './auth-cookies';

export interface CookieWrite {
  name: string;
  value: string;
  opts: CookieOpts;
}

export type LoginUser = { id: string; email: string; name: string | null };

export type FirstFactorResult =
  | { token: string; user: LoginUser }
  | { mfaRequired: true; mfaToken: string; user: LoginUser };

/**
 * Cookie writes that turn an API login response into browser state.
 * A full session sets `mergecrew_jwt` + `mergecrew_user`; an MFA-enrolled
 * user only gets the short-lived pre-MFA cookie and must pass /login/mfa.
 * Either way the magic-link marker and the dev sign-out flag are cleared.
 * Pure so route handlers and server actions apply the same writes.
 */
export function loginCookieWrites(result: FirstFactorResult, secure: boolean): CookieWrite[] {
  const clear = (name: string): CookieWrite => ({ name, value: '', opts: expiredCookieOpts(secure) });
  const writes: CookieWrite[] = [clear(MAGIC_LINK_STATE_COOKIE), clear(SIGNED_OUT_COOKIE)];
  if ('mfaRequired' in result && result.mfaRequired) {
    writes.push(
      clear(JWT_OVERRIDE_COOKIE),
      clear(USER_OVERRIDE_COOKIE),
      {
        name: MFA_PENDING_COOKIE,
        value: JSON.stringify({ t: result.mfaToken, u: result.user }),
        opts: cookieOpts(MFA_PENDING_MAX_AGE_S, secure),
      },
    );
    return writes;
  }
  const full = result as { token: string; user: LoginUser };
  writes.push(
    clear(MFA_PENDING_COOKIE),
    { name: JWT_OVERRIDE_COOKIE, value: full.token, opts: cookieOpts(SESSION_MAX_AGE_S, secure) },
    { name: USER_OVERRIDE_COOKIE, value: JSON.stringify(full.user), opts: cookieOpts(SESSION_MAX_AGE_S, secure) },
  );
  return writes;
}

/** Writes that remove every BFF session cookie (sign-out). */
export function signOutCookieWrites(secure: boolean): CookieWrite[] {
  return [JWT_OVERRIDE_COOKIE, USER_OVERRIDE_COOKIE, MFA_PENDING_COOKIE, MAGIC_LINK_STATE_COOKIE].map(
    (name) => ({ name, value: '', opts: expiredCookieOpts(secure) }),
  );
}

/** Where to send the browser after a first-factor login. */
export function postLoginPath(result: FirstFactorResult): string {
  return 'mfaRequired' in result && result.mfaRequired ? '/login/mfa' : '/';
}
