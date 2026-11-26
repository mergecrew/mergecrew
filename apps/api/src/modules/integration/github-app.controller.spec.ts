import { ForbiddenException } from '@nestjs/common';
import { GitHubAppController } from './github-app.controller';
import {
  signInstallState,
  verifyInstallGrant,
  verifyInstallState,
  type InstallStateClaims,
} from './github-install-tokens';
import type { FetchLike } from './github-install-verifier';

const ORG_ID = '00000000-0000-0000-0000-0000000000a1';
const USER_ID = '00000000-0000-0000-0000-0000000000u1';
const WEB = 'https://web.example';

const baseClaims: InstallStateClaims = {
  userId: USER_ID,
  orgId: ORG_ID,
  orgSlug: 'acme',
  projectSlug: 'shop',
  from: 'settings',
};

function makeController(opts: {
  user?: { userId: string } | undefined;
  org?: { id: string; slug: string } | null;
  role?: string | null;
  fetchImpl?: FetchLike;
} = {}) {
  const tenant = { user: () => ('user' in opts ? opts.user : { userId: USER_ID }) } as any;
  const prisma = {
    withSystem: async (fn: (db: any) => Promise<unknown>) =>
      fn({
        organization: { findFirst: async () => ('org' in opts ? opts.org : { id: ORG_ID, slug: 'acme' }) },
        membership: {
          findFirst: async () => {
            const role = 'role' in opts ? opts.role : 'operator';
            return role ? { role } : null;
          },
        },
      }),
  } as any;
  const c = new GitHubAppController(tenant, prisma);
  if (opts.fetchImpl) c.fetchImpl = opts.fetchImpl;
  return c;
}

/** Fake GitHub: token exchange + /user/installations. */
function fakeGitHub(installations: Array<{ id: number; login: string }>, opts: { tokenOk?: boolean } = {}) {
  const calls: string[] = [];
  const impl: FetchLike = async (url, init) => {
    calls.push(`${init?.method ?? 'GET'} ${url}`);
    if (url.startsWith('https://github.com/login/oauth/access_token')) {
      const body = JSON.parse(init?.body ?? '{}');
      if (opts.tokenOk === false || body.code !== 'good-code') {
        return { ok: true, status: 200, json: async () => ({ error: 'bad_verification_code' }) };
      }
      return { ok: true, status: 200, json: async () => ({ access_token: 'ghu_user_token' }) };
    }
    if (url.startsWith('https://api.github.com/user/installations')) {
      expect(init?.headers?.authorization).toBe('Bearer ghu_user_token');
      return {
        ok: true,
        status: 200,
        json: async () => ({
          total_count: installations.length,
          installations: installations.map((i) => ({ id: i.id, account: { login: i.login } })),
        }),
      };
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  return { impl, calls };
}

describe('GitHubAppController', () => {
  const saved = { ...process.env };
  beforeEach(() => {
    process.env.WEB_BASE_URL = WEB;
    process.env.JWT_SECRET = 'test-jwt-secret';
    process.env.GITHUB_APP_CLIENT_ID = 'Iv1.client';
    process.env.GITHUB_APP_CLIENT_SECRET = 'client-secret';
    process.env.GITHUB_APP_SLUG = 'mergecrew-test';
    delete process.env.GITHUB_APP_INSTALL_REDIRECT_URI;
    delete process.env.MERGECREW_PUBLIC_API_BASE_URL;
  });
  afterAll(() => {
    process.env = saved;
  });

  describe('install', () => {
    it('signs state carrying user + org for an operator member', async () => {
      const r = await makeController().install('acme', 'shop', 'wizard');
      const u = new URL(r.url);
      expect(u.origin + u.pathname).toBe('https://github.com/apps/mergecrew-test/installations/new');
      const claims = verifyInstallState(u.searchParams.get('state')!);
      expect(claims).toMatchObject({ userId: USER_ID, orgId: ORG_ID, orgSlug: 'acme', projectSlug: 'shop', from: 'wizard' });
      expect(claims?.installationId).toBeUndefined();
    });

    it('refuses non-members, viewers and unknown orgs', async () => {
      await expect(makeController({ role: null }).install('acme')).rejects.toBeInstanceOf(ForbiddenException);
      await expect(makeController({ role: 'viewer' }).install('acme')).rejects.toBeInstanceOf(ForbiddenException);
      await expect(makeController({ org: null }).install('nope')).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe('callback', () => {
    it('rejects missing or tampered state', async () => {
      const c = makeController();
      expect((await c.callback('1', undefined)).url).toBe(`${WEB}/?github_install_error=bad_callback`);
      const good = signInstallState(baseClaims);
      const [payload, sig] = good.split('.');
      const forged = Buffer.from(
        JSON.stringify({ ...JSON.parse(Buffer.from(payload!, 'base64url').toString()), orgId: 'other' }),
      ).toString('base64url');
      expect((await c.callback('1', `${forged}.${sig}`)).url).toBe(`${WEB}/?github_install_error=bad_state`);
    });

    it('rejects expired state', async () => {
      const old = signInstallState(baseClaims, Date.now() - 16 * 60 * 1000);
      expect((await makeController().callback('1', old)).url).toBe(`${WEB}/?github_install_error=bad_state`);
    });

    it('without a code, pins the installation and sends the user through GitHub OAuth', async () => {
      const r = await makeController().callback('4242', signInstallState(baseClaims), 'install');
      const u = new URL(r.url);
      expect(u.origin + u.pathname).toBe('https://github.com/login/oauth/authorize');
      expect(u.searchParams.get('client_id')).toBe('Iv1.client');
      const pinned = verifyInstallState(u.searchParams.get('state')!);
      expect(pinned).toMatchObject({ ...baseClaims, installationId: '4242', setupAction: 'install' });
    });

    it('passes redirect_uri when the public API URL is configured', async () => {
      process.env.MERGECREW_PUBLIC_API_BASE_URL = 'https://api.example/';
      const r = await makeController().callback('4242', signInstallState(baseClaims));
      expect(new URL(r.url).searchParams.get('redirect_uri')).toBe(
        'https://api.example/v1/integrations/github/install/callback',
      );
    });

    it('refuses a query installation_id that differs from the pinned one', async () => {
      const pinned = signInstallState({ ...baseClaims, installationId: '4242' });
      const r = await makeController().callback('9999', pinned, undefined, 'good-code');
      expect(r.url).toBe(`${WEB}/orgs/acme/projects/shop/settings?github_install_error=bad_callback`);
    });

    it('issues a grant when GitHub lists the installation for the user', async () => {
      const gh = fakeGitHub([{ id: 1, login: 'someone' }, { id: 4242, login: 'acme-gh' }]);
      const pinned = signInstallState({ ...baseClaims, installationId: '4242', setupAction: 'install' });
      const r = await makeController({ fetchImpl: gh.impl }).callback(undefined, pinned, undefined, 'good-code');
      const u = new URL(r.url);
      expect(u.origin + u.pathname).toBe(`${WEB}/orgs/acme/github-install/complete`);
      const grant = verifyInstallGrant(u.searchParams.get('grant')!);
      expect(grant).toMatchObject({
        userId: USER_ID,
        orgId: ORG_ID,
        installationId: '4242',
        accountLogin: 'acme-gh',
        setupAction: 'install',
      });
      expect(gh.calls[0]).toMatch(/^POST https:\/\/github.com\/login\/oauth\/access_token/);
    });

    it('also accepts the code GitHub sends when OAuth-during-install is enabled', async () => {
      const gh = fakeGitHub([{ id: 4242, login: 'acme-gh' }]);
      const r = await makeController({ fetchImpl: gh.impl }).callback(
        '4242',
        signInstallState(baseClaims),
        'install',
        'good-code',
      );
      expect(new URL(r.url).pathname).toBe('/orgs/acme/github-install/complete');
    });

    it("refuses an installation the GitHub user can't access", async () => {
      const gh = fakeGitHub([{ id: 1, login: 'mine' }]);
      const r = await makeController({ fetchImpl: gh.impl }).callback(
        '4242',
        signInstallState(baseClaims),
        undefined,
        'good-code',
      );
      expect(r.url).toBe(`${WEB}/orgs/acme/projects/shop/settings?github_install_error=installation_not_accessible`);
    });

    it('fails closed when the code exchange fails', async () => {
      const gh = fakeGitHub([{ id: 4242, login: 'acme-gh' }], { tokenOk: false });
      const r = await makeController({ fetchImpl: gh.impl }).callback(
        '4242',
        signInstallState({ ...baseClaims, from: 'wizard' }),
        undefined,
        'good-code',
      );
      expect(r.url).toBe(`${WEB}/orgs/acme/onboarding?github_install_error=github_verify_failed`);
    });

    it('fails closed when the App OAuth client is not configured', async () => {
      delete process.env.GITHUB_APP_CLIENT_SECRET;
      const r = await makeController().callback('4242', signInstallState(baseClaims), undefined, 'good-code');
      expect(r.url).toContain('github_install_error=oauth_not_configured');
    });
  });
});
