import { describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { SkillExecutor } from '../src/executor.js';
import { stockSkills, findStockSkill } from '../src/catalog.js';
import { makeSandbox } from './harness.js';

/**
 * End-to-end exercise of the repo.* skills against a real sandbox dir.
 * These prove that the executor → skill → fs path actually works, not
 * just that the type signatures line up.
 */

function executor() {
  const exec = new SkillExecutor();
  exec.registerAll(stockSkills);
  return exec;
}

describe('repo.read_file / repo.write_file', () => {
  it('writes a file then reads it back', async () => {
    const exec = executor();
    const { ctx, cleanup } = await makeSandbox();
    try {
      await exec.execute('repo.write_file', { path: 'README.md', content: 'hello\nworld\n' }, ctx);
      const read = await exec.execute<unknown, { content: string }>(
        'repo.read_file',
        { path: 'README.md' },
        ctx,
      );
      expect(read.output.content).toBe('hello\nworld\n');
      expect(read.brief).toMatch(/^read README\.md/);
    } finally {
      await cleanup();
    }
  });

  it('creates parent directories on write', async () => {
    const exec = executor();
    const { ctx, workspacePath, cleanup } = await makeSandbox();
    try {
      await exec.execute('repo.write_file', { path: 'a/b/c.txt', content: 'x' }, ctx);
      const stat = await fs.stat(path.join(workspacePath, 'a', 'b', 'c.txt'));
      expect(stat.isFile()).toBe(true);
    } finally {
      await cleanup();
    }
  });

  it('rejects path traversal outside the workspace', async () => {
    const exec = executor();
    const { ctx, cleanup } = await makeSandbox();
    try {
      await expect(
        exec.execute('repo.write_file', { path: '../escape.txt', content: 'x' }, ctx),
      ).rejects.toThrow(/escapes workspace/);
    } finally {
      await cleanup();
    }
  });

  it('rejects absolute paths', async () => {
    const exec = executor();
    const { ctx, cleanup } = await makeSandbox();
    try {
      await expect(
        exec.execute('repo.read_file', { path: '/etc/passwd' }, ctx),
      ).rejects.toThrow(/absolute paths are not allowed/);
    } finally {
      await cleanup();
    }
  });

  it('reading a missing file throws', async () => {
    const exec = executor();
    const { ctx, cleanup } = await makeSandbox();
    try {
      await expect(
        exec.execute('repo.read_file', { path: 'missing.txt' }, ctx),
      ).rejects.toThrow();
    } finally {
      await cleanup();
    }
  });
});

describe('repo.list_paths', () => {
  it('lists files relative to the workspace root, skipping ignored dirs', async () => {
    const exec = executor();
    const { ctx, workspacePath, cleanup } = await makeSandbox();
    try {
      await fs.writeFile(path.join(workspacePath, 'a.txt'), 'x');
      await fs.mkdir(path.join(workspacePath, 'sub'));
      await fs.writeFile(path.join(workspacePath, 'sub', 'b.txt'), 'y');
      // Should be skipped:
      await fs.mkdir(path.join(workspacePath, 'node_modules'));
      await fs.writeFile(path.join(workspacePath, 'node_modules', 'pkg.txt'), 'z');

      const r = await exec.execute<unknown, { paths: string[] }>(
        'repo.list_paths',
        { dir: '.' },
        ctx,
      );
      expect(r.output.paths.sort()).toEqual(['a.txt', path.join('sub', 'b.txt')].sort());
    } finally {
      await cleanup();
    }
  });

  it('honors the max cap', async () => {
    const exec = executor();
    const { ctx, workspacePath, cleanup } = await makeSandbox();
    try {
      for (let i = 0; i < 10; i++) {
        await fs.writeFile(path.join(workspacePath, `f${i}.txt`), '');
      }
      const r = await exec.execute<unknown, { paths: string[] }>(
        'repo.list_paths',
        { dir: '.', max: 3 },
        ctx,
      );
      expect(r.output.paths.length).toBe(3);
    } finally {
      await cleanup();
    }
  });
});

describe('catalog lookup', () => {
  it('findStockSkill returns the registered skill or undefined', () => {
    expect(findStockSkill('repo.read_file')?.name).toBe('repo.read_file');
    expect(findStockSkill('does.not.exist')).toBeUndefined();
  });
});
