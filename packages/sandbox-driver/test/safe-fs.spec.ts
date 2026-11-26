import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import {
  SAFE_FS_PINNED_FDS,
  WorkspacePathError,
  isGitMetadataPath,
  safeReadWorkspaceFile,
  safeResolveWorkspaceDir,
  safeWriteWorkspaceFile,
  walkWorkspaceFiles,
} from '../src/safe-fs.js';
import { ProcessDriver } from '../src/process-driver.js';

let base: string;
let ws: string;
let outside: string;

beforeEach(async () => {
  base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mc-safefs-')));
  ws = path.join(base, 'ws');
  outside = path.join(base, 'outside');
  await fs.mkdir(ws);
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, 'secret.txt'), 'TOP-SECRET');
  await fs.writeFile(path.join(ws, 'ok.txt'), 'fine');
});

afterEach(async () => {
  await fs.rm(base, { recursive: true, force: true });
});

describe('isGitMetadataPath', () => {
  it('flags .git segments, .gitmodules and .gitattributes at any depth', () => {
    for (const p of ['.git', '.git/config', 'a/.git/HEAD', '.GIT/config', '.gitmodules', 'sub/.gitattributes', './.git/hooks/pre-commit', '.g‌it/config']) {
      expect(isGitMetadataPath(p), p).toBe(true);
    }
    for (const p of ['.gitignore', 'src/git.ts', '.github/workflows/ci.yml', 'a/.gitkeep']) {
      expect(isGitMetadataPath(p), p).toBe(false);
    }
  });
});

describe('safeReadWorkspaceFile', () => {
  it('reads a regular file', async () => {
    expect((await safeReadWorkspaceFile(ws, 'ok.txt')).toString()).toBe('fine');
  });

  it('rejects a symlinked file pointing outside', async () => {
    await fs.symlink(path.join(outside, 'secret.txt'), path.join(ws, 'link.txt'));
    await expect(safeReadWorkspaceFile(ws, 'link.txt')).rejects.toBeInstanceOf(WorkspacePathError);
  });

  it('rejects a symlink to /proc/self/environ style targets', async () => {
    await fs.symlink('/proc/self/environ', path.join(ws, 'env'));
    await expect(safeReadWorkspaceFile(ws, 'env')).rejects.toThrow();
  });

  it('rejects a path through a symlinked directory pointing outside', async () => {
    await fs.symlink(outside, path.join(ws, 'dir'));
    await expect(safeReadWorkspaceFile(ws, 'dir/secret.txt')).rejects.toBeInstanceOf(WorkspacePathError);
  });

  it('rejects nested symlink chains that end outside', async () => {
    await fs.mkdir(path.join(ws, 'a/b'), { recursive: true });
    await fs.symlink('../../c', path.join(ws, 'a/b/hop'));
    await fs.symlink(outside, path.join(ws, 'c'));
    await expect(safeReadWorkspaceFile(ws, 'a/b/hop/secret.txt')).rejects.toBeInstanceOf(WorkspacePathError);
  });

  it('rejects a symlink into another tenant workspace (sibling dir)', async () => {
    const other = path.join(base, 'other-tenant');
    await fs.mkdir(other);
    await fs.writeFile(path.join(other, 'data'), 'x');
    await fs.symlink('../other-tenant/data', path.join(ws, 'peek'));
    await expect(safeReadWorkspaceFile(ws, 'peek')).rejects.toBeInstanceOf(WorkspacePathError);
  });

  it('rejects git metadata, including via an in-workspace symlink', async () => {
    await fs.mkdir(path.join(ws, '.git'));
    await fs.writeFile(path.join(ws, '.git/config'), '[core]');
    await expect(safeReadWorkspaceFile(ws, '.git/config')).rejects.toThrow(/git metadata/);
    await fs.symlink('.git', path.join(ws, 'innocent'));
    await expect(safeReadWorkspaceFile(ws, 'innocent/config')).rejects.toThrow(/git metadata/);
    await fs.writeFile(path.join(ws, '.gitattributes'), '* filter=x');
    await expect(safeReadWorkspaceFile(ws, '.gitattributes')).rejects.toThrow(/git metadata/);
  });

  it('rejects non-regular files (FIFO)', async () => {
    if (process.platform === 'win32') return;
    const { execFileSync } = await import('node:child_process');
    execFileSync('mkfifo', [path.join(ws, 'fifo')]);
    await expect(safeReadWorkspaceFile(ws, 'fifo')).rejects.toThrow(/regular file/);
  });

  it('allows symlinks that stay inside the workspace', async () => {
    await fs.symlink('ok.txt', path.join(ws, 'alias.txt'));
    // Final component is a symlink → O_NOFOLLOW refuses even in-tree links.
    await expect(safeReadWorkspaceFile(ws, 'alias.txt')).rejects.toBeInstanceOf(WorkspacePathError);
    await fs.mkdir(path.join(ws, 'real'));
    await fs.writeFile(path.join(ws, 'real/f'), 'inner');
    await fs.symlink('real', path.join(ws, 'aliasdir'));
    expect((await safeReadWorkspaceFile(ws, 'aliasdir/f')).toString()).toBe('inner');
  });
});

describe('safeWriteWorkspaceFile', () => {
  it('writes and creates parents', async () => {
    await safeWriteWorkspaceFile(ws, 'x/y/z.txt', 'hi');
    expect(await fs.readFile(path.join(ws, 'x/y/z.txt'), 'utf8')).toBe('hi');
  });

  it('never writes through a final-component symlink', async () => {
    await fs.symlink(path.join(outside, 'secret.txt'), path.join(ws, 'link.txt'));
    await expect(safeWriteWorkspaceFile(ws, 'link.txt', 'pwned')).rejects.toBeInstanceOf(WorkspacePathError);
    expect(await fs.readFile(path.join(outside, 'secret.txt'), 'utf8')).toBe('TOP-SECRET');
  });

  it('never writes through a symlinked parent directory pointing outside', async () => {
    await fs.symlink(outside, path.join(ws, 'dir'));
    await expect(safeWriteWorkspaceFile(ws, 'dir/new.txt', 'pwned')).rejects.toBeInstanceOf(WorkspacePathError);
    await expect(safeWriteWorkspaceFile(ws, 'dir/sub/new.txt', 'pwned')).rejects.toBeInstanceOf(WorkspacePathError);
    await expect(fs.access(path.join(outside, 'new.txt'))).rejects.toThrow();
    await expect(fs.access(path.join(outside, 'sub'))).rejects.toThrow();
  });

  it('refuses hard-linked files', async () => {
    await fs.writeFile(path.join(ws, 'orig'), 'o');
    await fs.link(path.join(ws, 'orig'), path.join(ws, 'hl'));
    await expect(safeWriteWorkspaceFile(ws, 'hl', 'x')).rejects.toThrow(/hard-linked/);
  });

  it('denies .git/**, .gitmodules, .gitattributes', async () => {
    await fs.mkdir(path.join(ws, '.git/hooks'), { recursive: true });
    for (const p of ['.git/config', '.git/hooks/pre-commit', '.gitmodules', 'pkg/.gitattributes', 'sub/.git']) {
      await expect(safeWriteWorkspaceFile(ws, p, 'x'), p).rejects.toThrow(/git metadata/);
    }
    await expect(fs.access(path.join(ws, '.git/hooks/pre-commit'))).rejects.toThrow();
  });

  it('rejects traversal and absolute paths', async () => {
    await expect(safeWriteWorkspaceFile(ws, '../outside/secret.txt', 'x')).rejects.toBeInstanceOf(WorkspacePathError);
    await expect(safeWriteWorkspaceFile(ws, '/etc/passwd', 'x')).rejects.toBeInstanceOf(WorkspacePathError);
  });
});

describe('walkWorkspaceFiles / safeResolveWorkspaceDir', () => {
  it('skips symlinked files and directories and git metadata', async () => {
    await fs.symlink(outside, path.join(ws, 'outdir'));
    await fs.symlink(path.join(outside, 'secret.txt'), path.join(ws, 'outfile'));
    await fs.mkdir(path.join(ws, '.git'));
    await fs.writeFile(path.join(ws, '.git/config'), 'x');
    await fs.writeFile(path.join(ws, '.gitmodules'), 'x');
    await fs.mkdir(path.join(ws, 'src'));
    await fs.writeFile(path.join(ws, 'src/a.ts'), 'a');
    const seen: string[] = [];
    const { root, dir } = await safeResolveWorkspaceDir(ws, '.');
    await walkWorkspaceFiles(root, dir, async (_abs, rel) => {
      seen.push(rel);
    });
    expect(seen.sort()).toEqual(['ok.txt', 'src/a.ts']);
  });

  it('refuses to list a directory that resolves outside', async () => {
    await fs.symlink(outside, path.join(ws, 'outdir'));
    await expect(safeResolveWorkspaceDir(ws, 'outdir')).rejects.toBeInstanceOf(WorkspacePathError);
  });
});

describe('race-ish: concurrent directory ↔ symlink swapping', () => {
  // The pinned-fd path (Linux /proc/self/fd) is race-free; the portable
  // fallback narrows but cannot fully close the window, so the stress
  // loop only asserts the strong guarantee where it is provided.
  it.runIf(SAFE_FS_PINNED_FDS)('never reads or writes outside while a component flips', async () => {
    await fs.mkdir(path.join(ws, 'flip'));
    await fs.writeFile(path.join(ws, 'flip/secret.txt'), 'inside');
    await fs.writeFile(path.join(outside, 'target.txt'), 'untouched');
    let stop = false;
    const flipper = (async () => {
      const realDir = path.join(ws, 'flip-real');
      while (!stop) {
        try {
          await fs.rename(path.join(ws, 'flip'), realDir);
          await fs.symlink(outside, path.join(ws, 'flip'));
          await new Promise((r) => setImmediate(r));
          await fs.unlink(path.join(ws, 'flip'));
          await fs.rename(realDir, path.join(ws, 'flip'));
        } catch {
          /* concurrent state — keep flipping */
        }
      }
    })();
    for (let i = 0; i < 400; i++) {
      const r = await safeReadWorkspaceFile(ws, 'flip/secret.txt').catch(() => null);
      if (r) expect(r.toString()).toBe('inside');
      await safeWriteWorkspaceFile(ws, 'flip/target.txt', 'pwned').catch(() => null);
    }
    stop = true;
    await flipper;
    expect(await fs.readFile(path.join(outside, 'target.txt'), 'utf8')).toBe('untouched');
  });
});

describe('ProcessDriver file bridge', () => {
  it('applies the same symlink + git-metadata checks', async () => {
    const driver = new ProcessDriver();
    const handle = await driver.start({ runId: 'r', projectId: 'p', organizationId: 'o', workspacePath: ws });
    await fs.symlink(path.join(outside, 'secret.txt'), path.join(ws, 'link'));
    await expect(driver.readFile(handle, 'link')).rejects.toThrow();
    await expect(driver.writeFile(handle, 'link', 'x')).rejects.toThrow();
    await expect(driver.writeFile(handle, '.git/config', 'x')).rejects.toThrow(/git metadata/);
    expect(await fs.readFile(path.join(outside, 'secret.txt'), 'utf8')).toBe('TOP-SECRET');
  });
});
