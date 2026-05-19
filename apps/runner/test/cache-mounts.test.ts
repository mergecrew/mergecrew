import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveCacheMounts } from '../src/cache-mounts.js';

describe('resolveCacheMounts', () => {
  let root: string;
  let savedEnv: string | undefined;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'cache-root-'));
    savedEnv = process.env.RUNNER_CACHE_ROOT;
    process.env.RUNNER_CACHE_ROOT = root;
  });

  afterEach(async () => {
    if (savedEnv === undefined) delete process.env.RUNNER_CACHE_ROOT;
    else process.env.RUNNER_CACHE_ROOT = savedEnv;
    await fs.rm(root, { recursive: true, force: true });
  });

  it('returns [] when no cache paths configured', async () => {
    expect(await resolveCacheMounts({ organizationId: 'o', projectId: 'p', cachePaths: undefined })).toEqual([]);
    expect(await resolveCacheMounts({ organizationId: 'o', projectId: 'p', cachePaths: [] })).toEqual([]);
  });

  it('rewrites ~/ to /home/mergecrew and tags by org+project', async () => {
    const mounts = await resolveCacheMounts({
      organizationId: 'org-a',
      projectId: 'proj-1',
      cachePaths: ['~/.cache/pip'],
    });
    expect(mounts).toHaveLength(1);
    expect(mounts[0]!.containerPath).toBe('/home/mergecrew/.cache/pip');
    expect(mounts[0]!.hostPath).toMatch(/org-a\/proj-1\//);
    // Host path was created.
    const stat = await fs.stat(mounts[0]!.hostPath);
    expect(stat.isDirectory()).toBe(true);
  });

  it('keeps absolute container paths verbatim', async () => {
    const mounts = await resolveCacheMounts({
      organizationId: 'org', projectId: 'p',
      cachePaths: ['/var/cache/apt'],
    });
    expect(mounts[0]!.containerPath).toBe('/var/cache/apt');
  });

  it('resolves relative paths against /workspace', async () => {
    const mounts = await resolveCacheMounts({
      organizationId: 'org', projectId: 'p',
      cachePaths: ['.pytest_cache'],
    });
    expect(mounts[0]!.containerPath).toBe('/workspace/.pytest_cache');
  });

  it('different orgs get different host paths (no cross-tenant)', async () => {
    const a = await resolveCacheMounts({
      organizationId: 'org-a', projectId: 'p',
      cachePaths: ['~/.cache/pip'],
    });
    const b = await resolveCacheMounts({
      organizationId: 'org-b', projectId: 'p',
      cachePaths: ['~/.cache/pip'],
    });
    expect(a[0]!.hostPath).not.toBe(b[0]!.hostPath);
  });

  it('host paths are deterministic across calls (cacheable)', async () => {
    const a = await resolveCacheMounts({
      organizationId: 'org-a', projectId: 'p',
      cachePaths: ['~/.cache/pip'],
    });
    const b = await resolveCacheMounts({
      organizationId: 'org-a', projectId: 'p',
      cachePaths: ['~/.cache/pip'],
    });
    expect(a[0]!.hostPath).toBe(b[0]!.hostPath);
  });
});
