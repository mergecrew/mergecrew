import path from 'node:path';
import { ValidationError } from '@mergecrew/domain';

/**
 * Resolve a user-supplied workspace-relative path to an absolute path inside
 * `workspacePath`, rejecting any traversal outside it. Returns the normalized
 * absolute path.
 */
export function resolveInWorkspace(workspacePath: string, rel: string): string {
  if (path.isAbsolute(rel)) {
    throw new ValidationError(`absolute paths are not allowed: ${rel}`);
  }
  const abs = path.resolve(workspacePath, rel);
  const root = path.resolve(workspacePath) + path.sep;
  if (!(abs + path.sep).startsWith(root) && abs !== path.resolve(workspacePath)) {
    throw new ValidationError(`path escapes workspace: ${rel}`);
  }
  return abs;
}
