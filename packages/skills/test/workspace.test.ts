import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { ValidationError } from '@mergecrew/domain';
import {
  resolveWorkspacePath,
  assertNoSymlinkEscape,
  resolveExistingWorkspacePath,
} from '../src/workspace.js';

describe('resolveWorkspacePath', () => {
  const ws = '/tmp/mergecrew-workspace-xyz';

  it('resolves a simple relative path to an absolute path inside the workspace', () => {
    expect(resolveWorkspacePath(ws, 'src/app.ts')).toBe(`${ws}/src/app.ts`);
    expect(resolveWorkspacePath(ws, '.')).toBe(ws);
  });

  it('rejects absolute paths', () => {
    expect(() => resolveWorkspacePath(ws, '/etc/passwd')).toThrow(ValidationError);
    expect(() => resolveWorkspacePath(ws, '/tmp/anything')).toThrow(ValidationError);
  });

  it('rejects traversal via ..', () => {
    expect(() => resolveWorkspacePath(ws, '../../../etc/passwd')).toThrow(ValidationError);
    expect(() => resolveWorkspacePath(ws, 'src/../../outside')).toThrow(ValidationError);
    // `src/..` lands on the root itself — that's allowed.
    expect(resolveWorkspacePath(ws, 'src/..')).toBe(ws);
  });

  it('rejects NUL bytes anywhere in the path', () => {
    expect(() => resolveWorkspacePath(ws, 'a\0b')).toThrow(/NUL byte/);
    expect(() => resolveWorkspacePath(ws, 'src\0/app.ts')).toThrow(/NUL byte/);
  });

  it('rejects empty strings', () => {
    expect(() => resolveWorkspacePath(ws, '')).toThrow(/empty/);
  });

  it('rejects non-string input', () => {
    // @ts-expect-error intentional bad input
    expect(() => resolveWorkspacePath(ws, null)).toThrow(/string/);
    // @ts-expect-error intentional bad input
    expect(() => resolveWorkspacePath(ws, 123)).toThrow(/string/);
  });

  it('handles ZIP-slip-style names with double-dot prefixes', () => {
    expect(() => resolveWorkspacePath(ws, '..\\evil.txt')).toThrow(ValidationError);
    expect(() => resolveWorkspacePath(ws, './../escape')).toThrow(ValidationError);
  });

  it('rejects paths that LOOK relative but resolve outside', () => {
    expect(() => resolveWorkspacePath('/tmp/ws', '../ws-other/file')).toThrow(ValidationError);
  });

  it('allows paths with similarly-prefixed siblings that DO not escape', () => {
    // Ensure the prefix check isn't a naive startsWith — '/tmp/ws-other'
    // must not be accepted just because it starts with '/tmp/ws'.
    expect(() => resolveWorkspacePath('/tmp/ws', '../ws-other/file')).toThrow();
    expect(resolveWorkspacePath('/tmp/ws', 'subdir/file')).toBe('/tmp/ws/subdir/file');
  });
});

describe('assertNoSymlinkEscape + resolveExistingWorkspacePath', () => {
  let ws: string;
  let outside: string;

  beforeEach(async () => {
    ws = await fs.mkdtemp(path.join(os.tmpdir(), 'wkspc-'));
    outside = await fs.mkdtemp(path.join(os.tmpdir(), 'outside-'));
    await fs.writeFile(path.join(outside, 'secret.txt'), 'pwned');
    await fs.writeFile(path.join(ws, 'ok.txt'), 'fine');
  });

  afterEach(async () => {
    await fs.rm(ws, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  });

  it('allows files that exist inside the workspace', async () => {
    const abs = resolveWorkspacePath(ws, 'ok.txt');
    await expect(assertNoSymlinkEscape(ws, abs)).resolves.toBeUndefined();
    await expect(resolveExistingWorkspacePath(ws, 'ok.txt')).resolves.toContain('ok.txt');
  });

  it('rejects a symlink that points outside the workspace', async () => {
    await fs.symlink(path.join(outside, 'secret.txt'), path.join(ws, 'link'));
    const abs = resolveWorkspacePath(ws, 'link');
    await expect(assertNoSymlinkEscape(ws, abs)).rejects.toThrow(/symlink/);
    await expect(resolveExistingWorkspacePath(ws, 'link')).rejects.toThrow(/symlink/);
  });

  it('allows symlinks that stay inside the workspace', async () => {
    await fs.symlink(path.join(ws, 'ok.txt'), path.join(ws, 'alias'));
    await expect(resolveExistingWorkspacePath(ws, 'alias')).resolves.toContain('ok.txt');
  });

  it('surfaces ENOENT for paths that do not exist (so callers distinguish missing vs malicious)', async () => {
    await expect(resolveExistingWorkspacePath(ws, 'no-such.txt')).rejects.toThrow(/ENOENT/);
  });
});
