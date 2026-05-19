import path from 'node:path';
import { promises as fs } from 'node:fs';
import { ValidationError } from '@mergecrew/domain';

/**
 * Resolve a user-supplied workspace-relative path to an absolute path inside
 * `workspacePath` and assert it stays inside. Returns the normalized absolute
 * path.
 *
 * Rejects:
 *  - absolute paths (`/etc/passwd`)
 *  - `..` traversal (`a/../../b`, `../../../etc/passwd`)
 *  - paths containing a NUL byte (`a/b\0evil`)
 *  - empty strings (no implicit "workspace root" — callers ask explicitly with `.`)
 *  - paths whose normalized form lands outside `workspacePath`
 *  - ZIP-slip-style names like `..\\evil` on Windows (normalized via path.resolve)
 *
 * Does NOT touch the filesystem — symlink-escape is a separate check in
 * `assertNoSymlinkEscape` so callers can opt out of the I/O cost for
 * paths that don't exist yet (e.g. about-to-write).
 *
 * Threat #554 / T-10 — the runner-isolation EPIC's path-traversal gate.
 */
export function resolveWorkspacePath(workspacePath: string, rel: string): string {
  if (typeof rel !== 'string') {
    throw new ValidationError(`path must be a string`);
  }
  if (rel.length === 0) {
    throw new ValidationError(`path must not be empty (use "." for the workspace root)`);
  }
  if (rel.includes('\0')) {
    throw new ValidationError(`path contains a NUL byte`);
  }
  if (path.isAbsolute(rel)) {
    throw new ValidationError(`absolute paths are not allowed: ${rel}`);
  }
  const root = path.resolve(workspacePath);
  const abs = path.resolve(root, rel);
  // Use path.relative — handles cross-platform separators + normalization.
  const relFromRoot = path.relative(root, abs);
  if (relFromRoot.startsWith('..') || path.isAbsolute(relFromRoot)) {
    throw new ValidationError(`path escapes workspace: ${rel}`);
  }
  return abs;
}

/**
 * Read-time symlink-escape check (#554 T-10). Resolves any symlinks in
 * `absPath` via `fs.realpath` and asserts the real path still lives
 * inside `workspacePath`. Use this for read operations on paths that
 * already exist; for new files, call `resolveWorkspacePath` and skip
 * this — there's nothing to follow.
 *
 * Throws `ValidationError` when the path realpath-escapes; throws the
 * underlying ENOENT/EACCES if the path doesn't exist or isn't readable
 * so callers can distinguish "missing file" from "attacker-controlled
 * symlink".
 */
export async function assertNoSymlinkEscape(
  workspacePath: string,
  absPath: string,
): Promise<void> {
  const root = await fs.realpath(workspacePath).catch(() => path.resolve(workspacePath));
  const real = await fs.realpath(absPath);
  const relFromRoot = path.relative(root, real);
  if (relFromRoot.startsWith('..') || path.isAbsolute(relFromRoot)) {
    throw new ValidationError(`path escapes workspace via symlink: ${absPath} → ${real}`);
  }
}

/**
 * Convenience: resolve + immediately verify no symlink escape. Use for
 * read paths where the file is expected to exist. Returns the realpath
 * (which is what callers usually want to pass to fs.readFile so the
 * read happens at the realpath, not the symlink).
 */
export async function resolveExistingWorkspacePath(
  workspacePath: string,
  rel: string,
): Promise<string> {
  const abs = resolveWorkspacePath(workspacePath, rel);
  await assertNoSymlinkEscape(workspacePath, abs);
  return fs.realpath(abs);
}

/**
 * Back-compat alias — old callers used this name. New code should use
 * `resolveWorkspacePath` (matches the #580 acceptance criterion).
 */
export const resolveInWorkspace = resolveWorkspacePath;
