import { describe, expect, it, vi } from 'vitest';
import {
  JWT_OVERRIDE_COOKIE,
  MAGIC_LINK_STATE_COOKIE,
  MFA_PENDING_COOKIE,
  USER_OVERRIDE_COOKIE,
  clientIpFromHeaders,
  magicLinkMarkerMatches,
  shouldUseSecureCookies,
} from '../src/lib/auth-cookies';
import { loginCookieWrites, postLoginPath, signOutCookieWrites } from '../src/lib/login-cookies';
import {
  resolveVerifiedEmail,
  verifiedGithubEmail,
  verifiedGoogleEmail,
} from '../src/lib/oauth-email';
import { bffTrustToken, productionSecretsError } from '../src/lib/secrets';

const user = { id: 'u1', email: 'u@example.com', name: null };

describe('OAuth verified-email resolution', () => {
  it('Google requires email_verified === true', () => {
    expect(verifiedGoogleEmail({ email: 'a@x.com', email_verified: true })).toBe('a@x.com');
    expect(verifiedGoogleEmail({ email: 'a@x.com', email_verified: false })).toBeNull();
    expect(verifiedGoogleEmail({ email: 'a@x.com', email_verified: 'true' })).toBeNull();
    expect(verifiedGoogleEmail({ email: 'a@x.com' })).toBeNull();
  });

  it('GitHub requires a verified primary address', () => {
    expect(
      verifiedGithubEmail([
        { email: 'other@x.com', primary: false, verified: true },
        { email: 'main@x.com', primary: true, verified: true },
      ]),
    ).toBe('main@x.com');
    expect(verifiedGithubEmail([{ email: 'main@x.com', primary: true, verified: false }])).toBeNull();
    expect(verifiedGithubEmail([{ email: 'v@x.com', primary: false, verified: true }])).toBeNull();
    expect(verifiedGithubEmail({ message: 'Resource not accessible' })).toBeNull();
  });

  it('GitHub ignores the (possibly unverified) profile email and asks /user/emails', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify([{ email: 'main@x.com', primary: true, verified: true }]), { status: 200 }),
    ) as unknown as typeof fetch;
    const email = await resolveVerifiedEmail(
      { provider: 'github', access_token: 'gho_x' },
      { email: 'victim@x.com' },
      fetchImpl,
    );
    expect(email).toBe('main@x.com');
    expect((fetchImpl as any).mock.calls[0][0]).toBe('https://api.github.com/user/emails');
  });

  it('fails closed when GitHub emails cannot be read or the provider is unknown', async () => {
    const denied = vi.fn(async () => new Response('{}', { status: 403 })) as unknown as typeof fetch;
    expect(await resolveVerifiedEmail({ provider: 'github', access_token: 't' }, {}, denied)).toBeNull();
    expect(await resolveVerifiedEmail({ provider: 'github' }, {}, denied)).toBeNull();
    expect(await resolveVerifiedEmail({ provider: 'other' }, { email: 'a@x.com', email_verified: true })).toBeNull();
  });
});

describe('session cookies', () => {
  it('are Secure for https origins and in production', () => {
    expect(shouldUseSecureCookies('https://mergecrew.dev', {})).toBe(true);
    expect(shouldUseSecureCookies('http://localhost:3000', { NODE_ENV: 'production' })).toBe(false);
    expect(shouldUseSecureCookies(null, { NODE_ENV: 'production' })).toBe(true);
    expect(shouldUseSecureCookies(null, { WEB_BASE_URL: 'https://x.dev' })).toBe(true);
    expect(shouldUseSecureCookies(null, { NODE_ENV: 'development' })).toBe(false);
  });

  it('a full login sets jwt + user cookies (Secure, httpOnly) and clears pending state', () => {
    const writes = loginCookieWrites({ token: 'jwt', user }, true);
    const byName = Object.fromEntries(writes.map((w) => [w.name, w]));
    expect(byName[JWT_OVERRIDE_COOKIE]).toMatchObject({ value: 'jwt', opts: { secure: true, httpOnly: true } });
    expect(byName[USER_OVERRIDE_COOKIE]?.opts.secure).toBe(true);
    expect(byName[MFA_PENDING_COOKIE]?.opts.maxAge).toBe(0);
    expect(byName[MAGIC_LINK_STATE_COOKIE]?.opts.maxAge).toBe(0);
    expect(postLoginPath({ token: 'jwt', user })).toBe('/');
  });

  it('an MFA-gated login sets only the short-lived pending cookie', () => {
    const r = { mfaRequired: true as const, mfaToken: 'pre', user };
    const writes = loginCookieWrites(r, true);
    const byName = Object.fromEntries(writes.map((w) => [w.name, w]));
    expect(byName[MFA_PENDING_COOKIE]?.opts.maxAge).toBeLessThanOrEqual(600);
    expect(byName[JWT_OVERRIDE_COOKIE]?.opts.maxAge).toBe(0);
    expect(byName[JWT_OVERRIDE_COOKIE]?.value).toBe('');
    expect(postLoginPath(r)).toBe('/login/mfa');
  });

  it('sign-out expires every BFF session cookie', () => {
    const names = signOutCookieWrites(true).map((w) => [w.name, w.opts.maxAge]);
    expect(names).toEqual(
      expect.arrayContaining([
        [JWT_OVERRIDE_COOKIE, 0],
        [USER_OVERRIDE_COOKIE, 0],
        [MFA_PENDING_COOKIE, 0],
      ]),
    );
  });
});

describe('magic-link same-browser marker', () => {
  it('matches only the requested email', () => {
    expect(magicLinkMarkerMatches('u@example.com', 'U@Example.com ')).toBe(true);
    expect(magicLinkMarkerMatches('u@example.com', 'attacker@example.com')).toBe(false);
    expect(magicLinkMarkerMatches(undefined, 'u@example.com')).toBe(false);
    expect(magicLinkMarkerMatches('', '')).toBe(false);
  });
});

describe('client IP forwarding', () => {
  const h = (o: Record<string, string>) => new Headers(o);
  it('uses the proxy-appended (right-most) X-Forwarded-For entry', () => {
    expect(clientIpFromHeaders(h({ 'x-forwarded-for': '1.1.1.1, 203.0.113.7' }))).toBe('203.0.113.7');
    expect(clientIpFromHeaders(h({ 'x-real-ip': '203.0.113.8' }))).toBe('203.0.113.8');
    expect(clientIpFromHeaders(h({}))).toBeNull();
  });
});

describe('web production secrets', () => {
  const strong = { NODE_ENV: 'production', NEXTAUTH_SECRET: 'a'.repeat(64), BFF_TRUST_TOKEN: 'b'.repeat(64) };
  it('refuses missing or default secrets in production', () => {
    expect(productionSecretsError(strong)).toBeNull();
    expect(productionSecretsError({ ...strong, NEXTAUTH_SECRET: 'change-me-in-prod' })).toMatch(/NEXTAUTH_SECRET/);
    expect(productionSecretsError({ ...strong, NEXTAUTH_SECRET: undefined })).toMatch(/NEXTAUTH_SECRET/);
    expect(productionSecretsError({ ...strong, BFF_TRUST_TOKEN: 'dev-trust-token' })).toMatch(/BFF_TRUST_TOKEN/);
    expect(productionSecretsError({ NODE_ENV: 'development' })).toBeNull();
  });

  it('never falls back to the dev trust token in production', () => {
    expect(bffTrustToken({ NODE_ENV: 'production' })).toBe('');
    expect(bffTrustToken({})).toBe('dev-trust-token');
  });
});
