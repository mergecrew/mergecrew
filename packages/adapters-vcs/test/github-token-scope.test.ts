/**
 * Installation tokens are minted per operation, limited to the connected
 * repository and to the permissions that operation needs; workspace git
 * never sees a credentialed URL.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const authCalls: any[] = [];
vi.mock('@octokit/auth-app', () => ({
  createAppAuth: () => async (req: any) => {
    authCalls.push(req);
    return { token: 'ghs_scopedtoken' };
  },
}));

const kit = {
  pulls: { create: vi.fn(async () => ({ data: { number: 7, html_url: 'u', state: 'open', merged_at: null } })) },
  actions: { createWorkflowDispatch: vi.fn(async () => ({})) },
  apps: { listReposAccessibleToInstallation: vi.fn() },
  paginate: vi.fn(async () => []),
};
vi.mock('@octokit/rest', () => ({ Octokit: vi.fn().mockImplementation(() => kit) }));

const safeGit = vi.hoisted(() => ({
  gitClone: vi.fn(async () => {}),
  gitPush: vi.fn(async () => {}),
}));
vi.mock('../src/safe-git.js', async (orig) => ({
  ...((await orig()) as object),
  gitClone: safeGit.gitClone,
  gitPush: safeGit.gitPush,
}));

import { GitHubProvider } from '../src/github.js';

const repo = { installationId: '42', repoId: '1234', repoFullName: 'acme/web', defaultBranch: 'main' };

beforeEach(() => {
  authCalls.length = 0;
  safeGit.gitClone.mockClear();
  safeGit.gitPush.mockClear();
});

describe('GitHubProvider token scoping', () => {
  const gh = () => new GitHubProvider({ appId: '1', privateKey: 'k' });

  it('clone mints a contents:read token for the single repo and uses a credential-free URL', async () => {
    await gh().cloneIntoWorkspace(repo, 'main', '/tmp/ws');
    expect(authCalls).toEqual([
      expect.objectContaining({
        type: 'installation',
        installationId: 42,
        repositoryIds: [1234],
        permissions: expect.objectContaining({ contents: 'read' }),
      }),
    ]);
    expect(authCalls[0].permissions.contents).toBe('read');
    const arg = (safeGit.gitClone.mock.calls[0] as any)[0];
    expect(arg.cleanUrl).toBe('https://github.com/acme/web.git');
    expect(arg.cleanUrl).not.toContain('ghs_');
    expect(arg.auth.origin).toBe('https://github.com');
  });

  it('push mints contents:write only for that repo and refuses the default branch before minting', async () => {
    await expect(gh().push('/tmp/ws', 'main', repo)).rejects.toThrow(/protected/);
    expect(authCalls).toHaveLength(0);
    await gh().push('/tmp/ws', 'mergecrew/run-1', repo);
    expect(authCalls[0]).toMatchObject({ repositoryIds: [1234], permissions: { contents: 'write' } });
    expect(authCalls[0].permissions.workflows).toBeUndefined();
    expect(authCalls[0].permissions.actions).toBeUndefined();
  });

  it('PR creation gets pull_requests:write without contents:write', async () => {
    await gh().openPullRequest(repo, { head: 'mergecrew/x', base: 'main', title: 't', body: 'b' });
    expect(authCalls[0]).toMatchObject({ repositoryIds: [1234], permissions: { pull_requests: 'write', contents: 'read' } });
  });

  it('falls back to repositoryNames when repoId is unknown', async () => {
    await gh().openPullRequest({ ...repo, repoId: undefined }, { head: 'mergecrew/x', base: 'main', title: 't', body: 'b' });
    expect(authCalls[0]).toMatchObject({ repositoryNames: ['web'] });
    expect(authCalls[0].repositoryIds).toBeUndefined();
  });

  it('getInstallationToken forwards an explicit scope', async () => {
    await gh().getInstallationToken('42', { repoId: '1234', permissions: { issues: 'read' } });
    expect(authCalls[0]).toMatchObject({ repositoryIds: [1234], permissions: { issues: 'read' } });
  });

  it('rejects repo names that could alter the remote URL', async () => {
    await expect(gh().cloneIntoWorkspace({ ...repo, repoFullName: 'evil.com@acme/web' }, 'main', '/tmp/ws')).rejects.toThrow(/invalid repoFullName/);
    await expect(gh().cloneIntoWorkspace({ ...repo, repoFullName: 'acme/../x' }, 'main', '/tmp/ws')).rejects.toThrow(/invalid repoFullName/);
  });
});
