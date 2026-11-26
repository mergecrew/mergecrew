import { constants as C, promises as fs, existsSync } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';

/**
 * Symlink-safe, workspace-confined file I/O.
 *
 * The workspace is attacker-controlled content: a tenant repo can
 * commit symlinks, and sandboxed build/test processes can create or
 * swap them at any time (the workspace is bind-mounted into the
 * sandbox read-write). Any host-side code that reads or writes a
 * workspace path on behalf of an agent MUST go through these helpers
 * instead of `fs.readFile` / `fs.writeFile`.
 *
 * Guarantees:
 *   - The path is textually confined (no absolute paths, no `..`
 *     escape, no NUL bytes).
 *   - Every component is resolved with `realpath` and must stay under
 *     the workspace realpath.
 *   - The final component is opened with `O_NOFOLLOW`; reads and
 *     writes only touch regular files (no FIFOs / devices / sockets).
 *   - On Linux the parent directory is opened first and the file is
 *     opened *through that pinned directory fd* (`/proc/self/fd/<n>/x`),
 *     and both fds are re-verified via `/proc/self/fd` after open. That
 *     makes the check race-free against a concurrent directory ↔
 *     symlink swap by a sandbox process. Elsewhere (macOS dev boxes)
 *     we fall back to realpath + inode re-verification.
 *   - Git metadata (`.git/**`, `.gitmodules`, `.gitattributes`, any
 *     path segment named `.git`) is never readable or writable.
 *   - Writes refuse files with more than one hard link.
 */

export class WorkspacePathError extends Error {
  readonly code: string;
  constructor(message: string, code = 'workspace_path_denied') {
    super(message);
    this.name = 'WorkspacePathError';
    this.code = code;
  }
}

/** Characters HFS+/NTFS ignore when comparing names — strip before matching `.git`. */
const IGNORABLE_CHARS = /[​-‏‪-‮⁠-⁤⁪-⁯﻿]/g;

function normalizeSegment(seg: string): string {
  return seg.replace(IGNORABLE_CHARS, '').toLowerCase();
}

/**
 * True when `rel` (workspace-relative) names git metadata the agent must
 * never touch: any `.git` segment (directory or gitfile), `.gitmodules`
 * or `.gitattributes` at any depth.
 */
export function isGitMetadataPath(rel: string): boolean {
  const segments = rel.split(/[\\/]+/).filter((s) => s.length > 0 && s !== '.');
  for (const raw of segments) {
    const seg = normalizeSegment(raw);
    if (seg === '.git' || seg === '.gitmodules' || seg === '.gitattributes') return true;
  }
  return false;
}

function assertNotGitMetadata(rel: string, original: string): void {
  if (isGitMetadataPath(rel)) {
    throw new WorkspacePathError(`access to git metadata is not allowed: ${original}`, 'git_metadata');
  }
}

function isInside(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function assertInside(root: string, candidate: string, original: string): void {
  if (!isInside(root, candidate)) {
    throw new WorkspacePathError(`path escapes workspace: ${original}`, 'escape');
  }
}

/**
 * Textual confinement. Returns the absolute path under `root` (which
 * should already be a realpath) without touching the filesystem.
 */
export function resolveTextual(root: string, rel: string): string {
  if (typeof rel !== 'string') throw new WorkspacePathError('path must be a string', 'invalid');
  if (rel.length === 0) {
    throw new WorkspacePathError('path must not be empty (use "." for the workspace root)', 'invalid');
  }
  if (rel.includes('\0')) throw new WorkspacePathError('path contains a NUL byte', 'invalid');
  if (path.isAbsolute(rel)) throw new WorkspacePathError(`absolute paths are not allowed: ${rel}`, 'absolute');
  const abs = path.resolve(root, rel);
  assertInside(root, abs, rel);
  return abs;
}

/**
 * Textual pre-check used by the sandbox drivers' file bridge. Keeps the
 * drivers' historical error messages and adds the git-metadata deny.
 */
export function assertTextuallyInside(host: string, relPath: string): void {
  if (typeof relPath !== 'string' || relPath.includes('\0')) {
    throw new Error('invalid path in sandbox file I/O');
  }
  if (path.isAbsolute(relPath)) {
    throw new Error(`absolute paths are not allowed in sandbox file I/O: ${relPath}`);
  }
  const abs = path.resolve(host, relPath);
  const rel = path.relative(host, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`path escapes the sandbox workspace: ${relPath}`);
  }
  if (isGitMetadataPath(rel)) {
    throw new Error(`access to git metadata is not allowed in sandbox file I/O: ${relPath}`);
  }
}

const HAS_PROC_FD = (() => {
  try {
    return process.platform === 'linux' && existsSync('/proc/self/fd');
  } catch {
    return false;
  }
})();

/** Exposed for tests that want to know which code path is active. */
export const SAFE_FS_PINNED_FDS = HAS_PROC_FD;

async function fdPath(fh: FileHandle): Promise<string | null> {
  if (!HAS_PROC_FD) return null;
  try {
    return await fs.readlink(`/proc/self/fd/${fh.fd}`);
  } catch {
    return null;
  }
}

async function workspaceRealRoot(workspacePath: string): Promise<string> {
  try {
    return await fs.realpath(workspacePath);
  } catch (err: any) {
    throw new WorkspacePathError(`workspace does not exist: ${workspacePath}`, err?.code ?? 'ENOENT');
  }
}

function mapOpenError(err: any, original: string): never {
  if (err?.code === 'ELOOP' || err?.code === 'EMLINK') {
    throw new WorkspacePathError(`refusing to follow symlink: ${original}`, 'symlink');
  }
  throw err;
}

/**
 * Open the directory `absDir` (must already be inside root) as a pinned
 * fd and verify where it really is. Returns the fd + its real path.
 */
async function openVerifiedDir(
  root: string,
  absDir: string,
  original: string,
): Promise<{ dir: FileHandle | null; real: string }> {
  const real = await fs.realpath(absDir);
  assertInside(root, real, original);
  assertNotGitMetadata(path.relative(root, real), original);
  if (!HAS_PROC_FD) return { dir: null, real };
  let dir: FileHandle;
  try {
    dir = await fs.open(real, C.O_RDONLY | C.O_DIRECTORY | C.O_NOFOLLOW);
  } catch (err) {
    mapOpenError(err, original);
  }
  const pinned = await fdPath(dir);
  if (!pinned || !isInside(root, pinned) || isGitMetadataPath(path.relative(root, pinned))) {
    await dir.close().catch(() => {});
    throw new WorkspacePathError(`path escapes workspace: ${original}`, 'escape');
  }
  return { dir, real: pinned };
}

async function verifyOpenedFile(
  root: string,
  fh: FileHandle,
  expectedReal: string,
  original: string,
): Promise<import('node:fs').Stats> {
  const st = await fh.stat();
  if (!st.isFile()) {
    throw new WorkspacePathError(`not a regular file: ${original}`, 'not_file');
  }
  const pinned = await fdPath(fh);
  if (pinned !== null) {
    if (!isInside(root, pinned) || isGitMetadataPath(path.relative(root, pinned))) {
      throw new WorkspacePathError(`path escapes workspace: ${original}`, 'escape');
    }
    return st;
  }
  // Portable fallback: the file we opened must be the same inode that
  // currently sits at the expected realpath, and that realpath must
  // still resolve to itself (no component was swapped for a symlink).
  const again = await fs.realpath(expectedReal).catch(() => null);
  if (again !== expectedReal) {
    throw new WorkspacePathError(`path changed during open: ${original}`, 'race');
  }
  const lst = await fs.lstat(expectedReal);
  if (lst.ino !== st.ino || lst.dev !== st.dev) {
    throw new WorkspacePathError(`path changed during open: ${original}`, 'race');
  }
  return st;
}

export interface SafeReadOpts {
  /** Refuse files larger than this many bytes. Default 16 MiB. */
  maxBytes?: number;
}

/**
 * Read a regular file inside the workspace. Throws `WorkspacePathError`
 * for escapes / symlinks / git metadata, and the underlying ENOENT /
 * EACCES for missing or unreadable files.
 */
export async function safeReadWorkspaceFile(
  workspacePath: string,
  rel: string,
  opts: SafeReadOpts = {},
): Promise<Buffer> {
  const root = await workspaceRealRoot(workspacePath);
  const abs = resolveTextual(root, rel);
  assertNotGitMetadata(path.relative(root, abs), rel);
  if (abs === root) throw new WorkspacePathError(`not a regular file: ${rel}`, 'not_file');

  const { dir, real: dirReal } = await openVerifiedDir(root, path.dirname(abs), rel);
  const base = path.basename(abs);
  const expected = path.join(dirReal, base);
  assertNotGitMetadata(path.relative(root, expected), rel);
  let fh: FileHandle;
  try {
    const target = dir ? `/proc/self/fd/${dir.fd}/${base}` : expected;
    fh = await fs.open(target, C.O_RDONLY | C.O_NOFOLLOW | C.O_NONBLOCK).catch((e) => mapOpenError(e, rel));
  } finally {
    await dir?.close().catch(() => {});
  }
  try {
    const st = await verifyOpenedFile(root, fh, expected, rel);
    const max = opts.maxBytes ?? 16 * 1024 * 1024;
    if (st.size > max) {
      throw new WorkspacePathError(`file too large (${st.size} bytes > ${max}): ${rel}`, 'too_large');
    }
    return await fh.readFile();
  } finally {
    await fh.close().catch(() => {});
  }
}

/**
 * Create every missing directory between `root` and `absDir` one
 * component at a time, refusing any component that is (or resolves
 * via a symlink to) something outside the workspace or inside git
 * metadata. Returns the realpath of `absDir`.
 */
async function ensureDirInside(root: string, absDir: string, original: string): Promise<string> {
  const relDir = path.relative(root, absDir);
  let cur = root;
  if (relDir === '') return root;
  for (const seg of relDir.split(path.sep)) {
    if (!seg || seg === '.') continue;
    const next = path.join(cur, seg);
    let st = await fs.lstat(next).catch((e: any) => (e?.code === 'ENOENT' ? null : Promise.reject(e)));
    if (!st) {
      await fs.mkdir(next, { mode: 0o755 }).catch((e: any) => {
        if (e?.code !== 'EEXIST') throw e;
      });
      st = await fs.lstat(next);
    }
    if (st.isSymbolicLink()) {
      const real = await fs.realpath(next);
      assertInside(root, real, original);
      assertNotGitMetadata(path.relative(root, real), original);
      const rst = await fs.stat(real);
      if (!rst.isDirectory()) throw new WorkspacePathError(`not a directory: ${original}`, 'not_dir');
      cur = real;
      continue;
    }
    if (!st.isDirectory()) throw new WorkspacePathError(`not a directory: ${original}`, 'not_dir');
    cur = next;
  }
  const real = await fs.realpath(cur);
  assertInside(root, real, original);
  assertNotGitMetadata(path.relative(root, real), original);
  return real;
}

/**
 * Write (create or truncate) a regular file inside the workspace,
 * creating parent directories as needed. Never follows a symlink in
 * the final component, never writes through a hard link, never writes
 * into git metadata.
 */
export async function safeWriteWorkspaceFile(
  workspacePath: string,
  rel: string,
  data: string | Buffer,
  opts: { mode?: number } = {},
): Promise<void> {
  const root = await workspaceRealRoot(workspacePath);
  const abs = resolveTextual(root, rel);
  assertNotGitMetadata(path.relative(root, abs), rel);
  if (abs === root) throw new WorkspacePathError(`cannot write the workspace root: ${rel}`, 'not_file');

  await ensureDirInside(root, path.dirname(abs), rel);
  const { dir, real: dirReal } = await openVerifiedDir(root, path.dirname(abs), rel);
  const base = path.basename(abs);
  const expected = path.join(dirReal, base);
  assertNotGitMetadata(path.relative(root, expected), rel);
  let fh: FileHandle;
  try {
    const target = dir ? `/proc/self/fd/${dir.fd}/${base}` : expected;
    // No O_TRUNC here: truncate only after the opened inode is verified.
    fh = await fs
      .open(target, C.O_WRONLY | C.O_CREAT | C.O_NOFOLLOW | C.O_NONBLOCK, opts.mode ?? 0o644)
      .catch((e) => mapOpenError(e, rel));
  } finally {
    await dir?.close().catch(() => {});
  }
  try {
    const st = await verifyOpenedFile(root, fh, expected, rel);
    if (st.nlink > 1) {
      throw new WorkspacePathError(`refusing to write a hard-linked file: ${rel}`, 'hardlink');
    }
    await fh.truncate(0);
    await fh.writeFile(data);
  } finally {
    await fh.close().catch(() => {});
  }
}

/**
 * Resolve a workspace-relative directory for listing. Returns its
 * realpath; refuses escapes and git metadata. The directory must exist.
 */
export async function safeResolveWorkspaceDir(workspacePath: string, rel: string): Promise<{ root: string; dir: string }> {
  const root = await workspaceRealRoot(workspacePath);
  const abs = resolveTextual(root, rel);
  assertNotGitMetadata(path.relative(root, abs), rel);
  const real = await fs.realpath(abs);
  assertInside(root, real, rel);
  assertNotGitMetadata(path.relative(root, real), rel);
  const st = await fs.stat(real);
  if (!st.isDirectory()) throw new WorkspacePathError(`not a directory: ${rel}`, 'not_dir');
  return { root, dir: real };
}

export interface WalkOpts {
  /** Directory names to skip (in addition to git metadata). */
  skipDirs?: ReadonlySet<string>;
}

/**
 * Depth-first walk of regular files under `startDir` (a realpath inside
 * `root`). Symlinks — to files or directories — are skipped entirely,
 * as is git metadata. `visit` receives the absolute path and the
 * root-relative path; return `false` to stop the walk.
 */
export async function walkWorkspaceFiles(
  root: string,
  startDir: string,
  visit: (abs: string, rel: string) => Promise<boolean | void>,
  opts: WalkOpts = {},
): Promise<void> {
  const skip = opts.skipDirs ?? new Set<string>();
  // Returns false when the visitor asked to stop.
  async function recurse(cur: string): Promise<boolean> {
    // Re-verify the directory right before listing it: a sandbox
    // process may have swapped it for a symlink since we queued it.
    const real = await fs.realpath(cur).catch(() => null);
    if (!real || real !== cur || !isInside(root, real)) return true;
    let entries;
    try {
      entries = await fs.readdir(cur, { withFileTypes: true });
    } catch {
      return true;
    }
    for (const e of entries) {
      if (e.isSymbolicLink()) continue;
      if (isGitMetadataPath(e.name)) continue;
      const full = path.join(cur, e.name);
      if (e.isDirectory()) {
        if (skip.has(e.name)) continue;
        if (!(await recurse(full))) return false;
      } else if (e.isFile()) {
        const cont = await visit(full, path.relative(root, full));
        if (cont === false) return false;
      }
    }
    return true;
  }
  await recurse(startDir);
}
