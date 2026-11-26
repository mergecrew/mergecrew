import { ConflictException } from '@nestjs/common';
import { ForbiddenError } from '@mergecrew/domain';
import { GitHubInstallationService } from './github-installation.service';
import { signInstallGrant, type InstallGrantClaims } from './github-install-tokens';

const ORG_A = '00000000-0000-0000-0000-00000000000a';
const ORG_B = '00000000-0000-0000-0000-00000000000b';
const USER = '00000000-0000-0000-0000-0000000000c1';

type Row = {
  organizationId: string;
  installationId: string;
  accountLogin: string | null;
  suspendedAt: Date | null;
  createdByUserId?: string | null;
};

/** In-memory stand-in for org_github_installations with RLS semantics. */
function fakePrisma(rows: Row[]) {
  const table = (orgScope: string | null) => ({
    findUnique: async ({ where }: any) =>
      rows.find((r) => r.installationId === where.installationId && (!orgScope || r.organizationId === orgScope)) ??
      null,
    findFirst: async ({ where }: any) =>
      rows.find(
        (r) =>
          r.organizationId === where.organizationId &&
          r.installationId === where.installationId &&
          (where.suspendedAt === undefined || r.suspendedAt === where.suspendedAt) &&
          (!orgScope || r.organizationId === orgScope),
      )
        ? { id: 'x' }
        : null,
    upsert: async ({ where, create, update }: any) => {
      const visible = rows.find(
        (r) => r.installationId === where.installationId && (!orgScope || r.organizationId === orgScope),
      );
      if (visible) {
        Object.assign(visible, update);
        return visible;
      }
      if (rows.some((r) => r.installationId === where.installationId)) {
        throw Object.assign(new Error('unique'), { code: 'P2002' });
      }
      const row = { suspendedAt: null, ...create };
      rows.push(row);
      return row;
    },
    deleteMany: async ({ where }: any) => {
      const before = rows.length;
      for (let i = rows.length - 1; i >= 0; i--) if (rows[i]!.installationId === where.installationId) rows.splice(i, 1);
      return { count: before - rows.length };
    },
    updateMany: async ({ where, data }: any) => {
      let count = 0;
      for (const r of rows) if (r.installationId === where.installationId) (Object.assign(r, data), count++);
      return { count };
    },
  });
  return {
    withTenant: async (orgId: string, fn: (tx: any) => Promise<unknown>) => fn({ orgGithubInstallation: table(orgId) }),
    withSystem: async (fn: (db: any) => Promise<unknown>) => fn({ orgGithubInstallation: table(null) }),
  } as any;
}

const grantFor = (over: Partial<InstallGrantClaims> = {}, now?: number) =>
  signInstallGrant(
    {
      userId: USER,
      orgId: ORG_A,
      orgSlug: 'a',
      projectSlug: '',
      from: 'settings',
      installationId: '555',
      accountLogin: 'acme-gh',
      ...over,
    },
    now,
  );

describe('GitHubInstallationService', () => {
  beforeAll(() => {
    process.env.JWT_SECRET = 'svc-test-secret';
  });

  describe('assertBound / isBound', () => {
    const svc = new GitHubInstallationService(
      fakePrisma([
        { organizationId: ORG_A, installationId: '555', accountLogin: null, suspendedAt: null },
        { organizationId: ORG_A, installationId: '666', accountLogin: null, suspendedAt: new Date() },
      ]),
    );

    it("allows the owning org, refuses other orgs, suspended, and 'manual'", async () => {
      await expect(svc.assertBound(ORG_A, '555')).resolves.toBeUndefined();
      await expect(svc.assertBound(ORG_B, '555')).rejects.toBeInstanceOf(ForbiddenError);
      await expect(svc.assertBound(ORG_A, '666')).rejects.toBeInstanceOf(ForbiddenError);
      await expect(svc.assertBound(ORG_A, 'manual')).rejects.toBeInstanceOf(ForbiddenError);
    });
  });

  describe('confirmGrant', () => {
    it('binds the installation for the matching user + org', async () => {
      const rows: Row[] = [];
      const svc = new GitHubInstallationService(fakePrisma(rows));
      const g = await svc.confirmGrant(grantFor(), { userId: USER, organizationId: ORG_A });
      expect(g.installationId).toBe('555');
      expect(rows).toEqual([
        expect.objectContaining({ organizationId: ORG_A, installationId: '555', accountLogin: 'acme-gh', createdByUserId: USER }),
      ]);
    });

    it('refreshes an existing binding of the same org (reinstall / update)', async () => {
      const rows: Row[] = [{ organizationId: ORG_A, installationId: '555', accountLogin: 'old', suspendedAt: null }];
      const svc = new GitHubInstallationService(fakePrisma(rows));
      await svc.confirmGrant(grantFor({ accountLogin: 'renamed' }), { userId: USER, organizationId: ORG_A });
      expect(rows).toHaveLength(1);
      expect(rows[0]!.accountLogin).toBe('renamed');
    });

    it('refuses grants for another user or org', async () => {
      const rows: Row[] = [];
      const svc = new GitHubInstallationService(fakePrisma(rows));
      await expect(svc.confirmGrant(grantFor(), { userId: 'someone-else', organizationId: ORG_A })).rejects.toBeInstanceOf(
        ForbiddenError,
      );
      await expect(svc.confirmGrant(grantFor(), { userId: USER, organizationId: ORG_B })).rejects.toBeInstanceOf(
        ForbiddenError,
      );
      expect(rows).toHaveLength(0);
    });

    it('refuses expired, forged and state-typed tokens', async () => {
      const svc = new GitHubInstallationService(fakePrisma([]));
      const caller = { userId: USER, organizationId: ORG_A };
      await expect(svc.confirmGrant(grantFor({}, Date.now() - 11 * 60 * 1000), caller)).rejects.toBeInstanceOf(
        ForbiddenError,
      );
      await expect(svc.confirmGrant('garbage', caller)).rejects.toBeInstanceOf(ForbiddenError);
      const [p] = grantFor().split('.');
      await expect(svc.confirmGrant(`${p}.AAAA`, caller)).rejects.toBeInstanceOf(ForbiddenError);
    });

    it('returns 409 when the installation is bound to another org', async () => {
      const rows: Row[] = [{ organizationId: ORG_B, installationId: '555', accountLogin: null, suspendedAt: null }];
      const svc = new GitHubInstallationService(fakePrisma(rows));
      await expect(svc.confirmGrant(grantFor(), { userId: USER, organizationId: ORG_A })).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(rows[0]!.organizationId).toBe(ORG_B);
    });
  });

  describe('handleInstallationEvent', () => {
    it('removes bindings on deleted, toggles suspension on suspend/unsuspend', async () => {
      const rows: Row[] = [{ organizationId: ORG_A, installationId: '555', accountLogin: null, suspendedAt: null }];
      const svc = new GitHubInstallationService(fakePrisma(rows));
      await svc.handleInstallationEvent('suspend', '555');
      expect(rows[0]!.suspendedAt).toBeInstanceOf(Date);
      expect(await svc.isBound(ORG_A, '555')).toBe(false);
      await svc.handleInstallationEvent('unsuspend', '555');
      expect(rows[0]!.suspendedAt).toBeNull();
      expect(await svc.isBound(ORG_A, '555')).toBe(true);
      await svc.handleInstallationEvent('deleted', '555');
      expect(rows).toHaveLength(0);
    });

    it('ignores other actions and malformed ids', async () => {
      const rows: Row[] = [{ organizationId: ORG_A, installationId: '555', accountLogin: null, suspendedAt: null }];
      const svc = new GitHubInstallationService(fakePrisma(rows));
      await svc.handleInstallationEvent('created', '555');
      await svc.handleInstallationEvent('deleted', 'undefined');
      expect(rows).toHaveLength(1);
    });
  });
});
