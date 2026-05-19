import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chownWorkspaceForSandbox } from '../src/workspace-prep.js';

describe('chownWorkspaceForSandbox', () => {
  let workspace: string;

  beforeEach(async () => {
    workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'chown-test-'));
  });

  afterEach(async () => {
    await fs.rm(workspace, { recursive: true, force: true });
  });

  it('warns and returns when chown is denied (EPERM)', async () => {
    const warn = vi.fn();
    const spy = vi.spyOn(fs, 'lchown').mockRejectedValueOnce(
      Object.assign(new Error('EPERM'), { code: 'EPERM' }),
    );
    try {
      await chownWorkspaceForSandbox(workspace, { warn, info: () => {} });
    } finally {
      spy.mockRestore();
    }
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toMatch(/CAP_CHOWN/);
  });

  it('warns and returns when chown is denied (EACCES)', async () => {
    const warn = vi.fn();
    const spy = vi.spyOn(fs, 'lchown').mockRejectedValueOnce(
      Object.assign(new Error('EACCES'), { code: 'EACCES' }),
    );
    try {
      await chownWorkspaceForSandbox(workspace, { warn });
    } finally {
      spy.mockRestore();
    }
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('rethrows non-permission errors', async () => {
    const spy = vi.spyOn(fs, 'lchown').mockRejectedValueOnce(
      Object.assign(new Error('disk burst into flames'), { code: 'EIO' }),
    );
    try {
      await expect(chownWorkspaceForSandbox(workspace)).rejects.toThrow(/flames/);
    } finally {
      spy.mockRestore();
    }
  });

  it('walks the directory tree and calls lchown on every entry', async () => {
    await fs.mkdir(path.join(workspace, 'sub'));
    await fs.writeFile(path.join(workspace, 'a.txt'), 'x');
    await fs.writeFile(path.join(workspace, 'sub', 'b.txt'), 'y');

    const calls: string[] = [];
    const spy = vi.spyOn(fs, 'lchown').mockImplementation(async (p) => {
      calls.push(p as string);
    });
    try {
      await chownWorkspaceForSandbox(workspace);
    } finally {
      spy.mockRestore();
    }
    // Should include the root, the subdir, the two files.
    expect(calls).toContain(workspace);
    expect(calls.some((c) => c.endsWith('a.txt'))).toBe(true);
    expect(calls.some((c) => c.endsWith('b.txt'))).toBe(true);
    expect(calls.some((c) => c.endsWith('sub'))).toBe(true);
  });

});
