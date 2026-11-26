/**
 * connect-repo / installation-repos / github-actions deploy targets must
 * refuse GitHub App installations that aren't bound to the calling org.
 */
const listInstallationRepos = jest.fn(async () => [
  { repoId: '1', repoFullName: 'acme/shop', defaultBranch: 'main', private: true },
]);
jest.mock('@mergecrew/adapters-vcs', () => ({
  getGitHubAppCredentials: () => ({ appId: '1', privateKey: 'k' }),
  GitHubProvider: class {
    listInstallationRepos = listInstallationRepos;
  },
}));
// ESM-only Octokit underneath; not exercised here.
jest.mock('@mergecrew/adapters-tracker', () => ({ GitHubIssuesProvider: class {} }));

import { ForbiddenError } from '@mergecrew/domain';
import { ProjectService, isDevMode } from './project.service';

const ORG_A = '00000000-0000-0000-0000-00000000000a';
const ORG_B = '00000000-0000-0000-0000-00000000000b';

function makeService(orgId: string, bindings: Array<{ organizationId: string; installationId: string }>) {
  const writes: string[] = [];
  const tx = (scope: string) => ({
    orgGithubInstallation: {
      findFirst: async ({ where }: any) =>
        bindings.some(
          (b) => b.organizationId === scope && b.organizationId === where.organizationId && b.installationId === where.installationId,
        )
          ? { id: 'b' }
          : null,
    },
    connectedRepo: { upsert: async () => (writes.push('connectedRepo'), { id: 'cr' }) },
    trackerTarget: { findUnique: async () => null, upsert: async () => ({}) },
    deployTarget: { upsert: async () => (writes.push('deployTarget'), { id: 'dt' }) },
  });
  const prisma = { withTenant: async (o: string, fn: (t: any) => Promise<unknown>) => fn(tx(o)) } as any;
  const tenant = { require: () => ({ organizationId: orgId, organizationSlug: 'x', userId: 'u', role: 'operator' }) } as any;
  const telemetry = { emit: async () => {} } as any;
  const svc = new ProjectService(prisma, tenant, {} as any, telemetry, {} as any);
  (svc as any).detail = async () => ({ id: 'p1', organizationId: orgId });
  return { svc, writes };
}

const repoInput = (installationId: string) => ({
  installationId,
  repoId: '1',
  repoFullName: 'acme/shop',
  defaultBranch: 'main',
});

describe('installation binding checks in ProjectService', () => {
  const saved = { ...process.env };
  const bindings = [{ organizationId: ORG_A, installationId: '111' }];

  beforeEach(() => {
    listInstallationRepos.mockClear();
    process.env.NODE_ENV = 'production';
    process.env.MERGECREW_DEV_AUTO_LOGIN = 'false';
  });
  afterAll(() => {
    process.env = saved;
  });

  it('lists repos for an installation bound to the caller org', async () => {
    const { svc } = makeService(ORG_A, bindings);
    await expect(svc.listInstallationRepos('111')).resolves.toHaveLength(1);
  });

  it("returns 403 for another org's installation without calling GitHub", async () => {
    const { svc } = makeService(ORG_B, bindings);
    await expect(svc.listInstallationRepos('111')).rejects.toBeInstanceOf(ForbiddenError);
    expect(listInstallationRepos).not.toHaveBeenCalled();
  });

  it('connects a repo through a bound installation', async () => {
    const { svc, writes } = makeService(ORG_A, bindings);
    await svc.connectRepo('p', repoInput('111'));
    expect(writes).toContain('connectedRepo');
  });

  it("refuses to connect through another org's installation", async () => {
    const { svc, writes } = makeService(ORG_B, bindings);
    await expect(svc.connectRepo('p', repoInput('111'))).rejects.toBeInstanceOf(ForbiddenError);
    expect(writes).toEqual([]);
  });

  it("refuses the 'manual' placeholder outside dev mode, allows it in dev", async () => {
    const prod = makeService(ORG_A, bindings);
    await expect(prod.svc.connectRepo('p', repoInput('manual'))).rejects.toBeInstanceOf(ForbiddenError);
    expect(prod.writes).toEqual([]);

    process.env.MERGECREW_DEV_AUTO_LOGIN = 'true';
    const dev = makeService(ORG_A, bindings);
    await dev.svc.connectRepo('p', repoInput('manual'));
    expect(dev.writes).toContain('connectedRepo');
  });

  it('refuses github-actions deploy targets with an unbound installation', async () => {
    const { svc, writes } = makeService(ORG_B, bindings);
    await expect(
      svc.upsertDeployTarget('p', { kind: 'dev', adapterId: 'github-actions', config: { installationId: '111' } }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(writes).toEqual([]);
    const ok = makeService(ORG_A, bindings);
    await ok.svc.upsertDeployTarget('p', { kind: 'dev', adapterId: 'github-actions', config: { installationId: '111' } });
    expect(ok.writes).toContain('deployTarget');
  });
});

describe('isDevMode', () => {
  it('follows MERGECREW_DEV_AUTO_LOGIN, else NODE_ENV', () => {
    expect(isDevMode({ NODE_ENV: 'production' })).toBe(false);
    expect(isDevMode({ NODE_ENV: 'development' })).toBe(true);
    expect(isDevMode({})).toBe(true);
    expect(isDevMode({ NODE_ENV: 'production', MERGECREW_DEV_AUTO_LOGIN: 'true' })).toBe(true);
    expect(isDevMode({ NODE_ENV: 'development', MERGECREW_DEV_AUTO_LOGIN: 'false' })).toBe(false);
  });
});
