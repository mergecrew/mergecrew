import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import pino from 'pino';
import {
  bootstrapWorkspace,
  bootstrapWorkspaceViaDriver,
  cleanupWorkspace,
  type ConnectedRepoForBootstrap,
} from '../src/workspace.js';
import type { VcsProvider } from '@mergecrew/adapters-vcs';
import type { ExecResult, SandboxDriver, SandboxHandle } from '@mergecrew/sandbox-driver';

const logger = pino({ level: 'silent' });

function fakeVcs(opts: { onClone?: (dest: string) => Promise<void> } = {}): VcsProvider {
  // Only the methods exercised by bootstrap are real; the rest throw if
  // a test accidentally relies on them.
  return new Proxy(
    {
      cloneIntoWorkspace: vi.fn(async (_repo, _ref, dest: string) => {
        await opts.onClone?.(dest);
      }),
    } as any,
    {
      get(target, prop) {
        if (prop in target) return (target as any)[prop];
        return () => {
          throw new Error(`VcsProvider.${String(prop)} not stubbed in this test`);
        };
      },
    },
  );
}

const REPO: ConnectedRepoForBootstrap = {
  installationId: 'inst_1',
  repoId: 'repo_1',
  repoFullName: 'acme/widget',
  defaultBranch: 'main',
};

describe('bootstrapWorkspace', () => {
  let workspacePath: string;

  beforeEach(async () => {
    workspacePath = await fs.mkdtemp(path.join(tmpdir(), 'mergecrew-test-'));
  });
  afterEach(async () => {
    await fs.rm(workspacePath, { recursive: true, force: true }).catch(() => {});
  });

  it('clones into an empty workspace and reports the branch', async () => {
    const vcs = fakeVcs({
      onClone: async (dest) => {
        // Simulate `git clone` by creating a .git dir at dest.
        await fs.mkdir(path.join(dest, '.git'), { recursive: true });
      },
    });
    const result = await bootstrapWorkspace({
      workspacePath,
      vcs,
      fetchConnectedRepo: async () => REPO,
      logger,
    });
    expect(result).toEqual({ kind: 'cloned', branch: 'main' });
    await expect(fs.access(path.join(workspacePath, '.git'))).resolves.toBeUndefined();
  });

  it('returns reused when .git already exists (idempotent re-entry)', async () => {
    await fs.mkdir(path.join(workspacePath, '.git'), { recursive: true });
    const vcs = fakeVcs();
    const result = await bootstrapWorkspace({
      workspacePath,
      vcs,
      fetchConnectedRepo: async () => {
        throw new Error('fetchConnectedRepo should not be called on reuse');
      },
      logger,
    });
    expect(result).toEqual({ kind: 'reused' });
    expect(vcs.cloneIntoWorkspace).not.toHaveBeenCalled();
  });

  it('fails with github_app_not_configured when vcs is undefined', async () => {
    const result = await bootstrapWorkspace({
      workspacePath,
      vcs: undefined,
      fetchConnectedRepo: async () => REPO,
      logger,
    });
    expect(result.kind).toBe('failed');
    if (result.kind !== 'failed') throw new Error('unreachable');
    expect(result.reason).toBe('github_app_not_configured');
    expect(result.message).toMatch(/GITHUB_APP_ID/);
  });

  it('fails with no_connected_repo when the project has no ConnectedRepo row', async () => {
    const vcs = fakeVcs();
    const result = await bootstrapWorkspace({
      workspacePath,
      vcs,
      fetchConnectedRepo: async () => null,
      logger,
    });
    expect(result.kind).toBe('failed');
    if (result.kind !== 'failed') throw new Error('unreachable');
    expect(result.reason).toBe('no_connected_repo');
    expect(vcs.cloneIntoWorkspace).not.toHaveBeenCalled();
  });

  it('fails with clone_failed and surfaces the underlying error message', async () => {
    const vcs = fakeVcs({
      onClone: async () => {
        throw new Error('fatal: Authentication failed');
      },
    });
    const result = await bootstrapWorkspace({
      workspacePath,
      vcs,
      fetchConnectedRepo: async () => REPO,
      logger,
    });
    expect(result.kind).toBe('failed');
    if (result.kind !== 'failed') throw new Error('unreachable');
    expect(result.reason).toBe('clone_failed');
    expect(result.message).toMatch(/Authentication failed/);
  });

  it('wipes leftover state before retrying a clone', async () => {
    // Pretend a previous bootstrap left half-written content but no .git.
    await fs.writeFile(path.join(workspacePath, 'stale.txt'), 'leftover');
    const seen: string[] = [];
    const vcs = fakeVcs({
      onClone: async (dest) => {
        // git clone semantics: dest must be empty. Capture what was there.
        const entries = await fs.readdir(dest);
        seen.push(...entries);
        await fs.mkdir(path.join(dest, '.git'), { recursive: true });
      },
    });
    const result = await bootstrapWorkspace({
      workspacePath,
      vcs,
      fetchConnectedRepo: async () => REPO,
      logger,
    });
    expect(result.kind).toBe('cloned');
    expect(seen).toEqual([]); // wipe happened — dest was empty at clone time
  });
});

describe('bootstrapWorkspaceViaDriver (V2.ag step 4)', () => {
  const REPO: ConnectedRepoForBootstrap = {
    installationId: 'install-abc',
    repoFullName: 'acme/widget',
    defaultBranch: 'main',
  };
  const HANDLE: SandboxHandle = {
    id: 'sandbox-x',
    driver: 'fake',
    workspacePath: '/agent/workspace',
  };

  function fakeDriver(args: {
    gitDirExists?: boolean;
    cloneExit?: number;
    cloneStderr?: string;
    onExec?: (cmd: string, opts: { args: string[] }) => void;
  } = {}): SandboxDriver {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const driver: SandboxDriver = {
      name: 'fake',
      async start() {
        return HANDLE;
      },
      async exec(_handle, opts): Promise<ExecResult> {
        calls.push({ cmd: opts.cmd, args: opts.args });
        args.onExec?.(opts.cmd, { args: opts.args });
        if (opts.cmd === 'test' && opts.args[0] === '-d' && opts.args[1] === '.git') {
          return {
            exitCode: args.gitDirExists ? 0 : 1,
            stdout: '',
            stderr: '',
            timedOut: false,
          };
        }
        if (opts.cmd === 'git' && opts.args[0] === 'clone') {
          return {
            exitCode: args.cloneExit ?? 0,
            stdout: '',
            stderr: args.cloneStderr ?? '',
            timedOut: false,
          };
        }
        return { exitCode: 0, stdout: '', stderr: '', timedOut: false };
      },
      async readFile() {
        return Buffer.from('');
      },
      async writeFile() {},
      async kill() {},
      async stop() {},
    };
    (driver as any).recordedCalls = calls;
    return driver;
  }

  function fakeGithubVcs(opts: { token?: string; tokenError?: Error } = {}): VcsProvider {
    return new Proxy(
      {
        id: 'github' as const,
        getInstallationToken: vi.fn(async () => {
          if (opts.tokenError) throw opts.tokenError;
          return opts.token ?? 'ghs_fake_token_123';
        }),
      } as any,
      {
        get(target, prop) {
          if (prop in target) return (target as any)[prop];
          return () => {
            throw new Error(`VcsProvider.${String(prop)} not stubbed in this test`);
          };
        },
      },
    ) as unknown as VcsProvider;
  }

  it('returns reused when .git already exists inside the sandbox (idempotent)', async () => {
    const driver = fakeDriver({ gitDirExists: true });
    const result = await bootstrapWorkspaceViaDriver({
      driver,
      handle: HANDLE,
      vcs: fakeGithubVcs(),
      fetchConnectedRepo: async () => REPO,
      logger,
    });
    expect(result).toEqual({ kind: 'reused' });
    const calls = (driver as any).recordedCalls as Array<{ cmd: string; args: string[] }>;
    // Only the `test -d .git` probe should have fired — no clone.
    expect(calls).toEqual([{ cmd: 'test', args: ['-d', '.git'] }]);
  });

  it('clones via driver.exec with an installation-token URL when sandbox is empty', async () => {
    const driver = fakeDriver({ cloneExit: 0 });
    const result = await bootstrapWorkspaceViaDriver({
      driver,
      handle: HANDLE,
      vcs: fakeGithubVcs({ token: 'ghs_clone_token' }),
      fetchConnectedRepo: async () => REPO,
      logger,
    });
    expect(result).toEqual({ kind: 'cloned', branch: 'main' });
    const calls = (driver as any).recordedCalls as Array<{ cmd: string; args: string[] }>;
    const cloneCall = calls.find((c) => c.cmd === 'git' && c.args[0] === 'clone');
    expect(cloneCall).toBeDefined();
    // Token baked into the URL via x-access-token auth.
    const cloneUrlArg = cloneCall!.args.find((a) => a.includes('https://'));
    expect(cloneUrlArg).toContain('x-access-token:ghs_clone_token@github.com/acme/widget.git');
    // Branch flag pinned to default branch.
    expect(cloneCall!.args).toContain('--branch');
    expect(cloneCall!.args).toContain('main');
  });

  it('fails with github_app_not_configured when vcs is undefined', async () => {
    const driver = fakeDriver();
    const result = await bootstrapWorkspaceViaDriver({
      driver,
      handle: HANDLE,
      vcs: undefined,
      fetchConnectedRepo: async () => REPO,
      logger,
    });
    expect(result.kind).toBe('failed');
    if (result.kind !== 'failed') throw new Error('unreachable');
    expect(result.reason).toBe('github_app_not_configured');
  });

  it('fails with no_connected_repo when the project has no row', async () => {
    const driver = fakeDriver();
    const result = await bootstrapWorkspaceViaDriver({
      driver,
      handle: HANDLE,
      vcs: fakeGithubVcs(),
      fetchConnectedRepo: async () => null,
      logger,
    });
    expect(result.kind).toBe('failed');
    if (result.kind !== 'failed') throw new Error('unreachable');
    expect(result.reason).toBe('no_connected_repo');
  });

  it('fails with clone_failed when getInstallationToken throws', async () => {
    const driver = fakeDriver();
    const result = await bootstrapWorkspaceViaDriver({
      driver,
      handle: HANDLE,
      vcs: fakeGithubVcs({ tokenError: new Error('jwt rejected') }),
      fetchConnectedRepo: async () => REPO,
      logger,
    });
    expect(result.kind).toBe('failed');
    if (result.kind !== 'failed') throw new Error('unreachable');
    expect(result.reason).toBe('clone_failed');
    expect(result.message).toMatch(/jwt rejected/);
  });

  it('fails with clone_failed and SCRUBS the token from the stderr message', async () => {
    const driver = fakeDriver({
      cloneExit: 128,
      cloneStderr:
        'fatal: unable to access https://x-access-token:ghs_clone_token@github.com/acme/widget.git/',
    });
    const result = await bootstrapWorkspaceViaDriver({
      driver,
      handle: HANDLE,
      vcs: fakeGithubVcs({ token: 'ghs_clone_token' }),
      fetchConnectedRepo: async () => REPO,
      logger,
    });
    expect(result.kind).toBe('failed');
    if (result.kind !== 'failed') throw new Error('unreachable');
    expect(result.reason).toBe('clone_failed');
    // Token must not leak in the failure message.
    expect(result.message).not.toContain('ghs_clone_token');
    expect(result.message).toContain('***');
  });
});

describe('cleanupWorkspace', () => {
  it('removes the per-run workspace directory', async () => {
    const dir = await fs.mkdtemp(path.join(tmpdir(), 'mergecrew-cleanup-test-'));
    const runId = path.basename(dir);
    process.env.RUNNER_WORKSPACE_ROOT = path.dirname(dir);
    await fs.writeFile(path.join(dir, 'sentinel'), 'x');
    await cleanupWorkspace({ runId, logger });
    await expect(fs.access(dir)).rejects.toThrow();
    delete process.env.RUNNER_WORKSPACE_ROOT;
  });

  it('does not throw when the workspace directory is already gone', async () => {
    const root = await fs.mkdtemp(path.join(tmpdir(), 'mergecrew-cleanup-test-'));
    process.env.RUNNER_WORKSPACE_ROOT = root;
    await expect(
      cleanupWorkspace({ runId: 'nonexistent-run-id', logger }),
    ).resolves.toBeUndefined();
    delete process.env.RUNNER_WORKSPACE_ROOT;
    await fs.rm(root, { recursive: true, force: true });
  });
});
