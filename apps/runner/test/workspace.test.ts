import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import pino from 'pino';
import {
  bootstrapWorkspace,
  cleanupWorkspace,
  type ConnectedRepoForBootstrap,
} from '../src/workspace.js';
import type { VcsProvider } from '@mergecrew/adapters-vcs';

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
