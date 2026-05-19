import { promises as fs } from 'node:fs';
import path from 'node:path';
import { SANDBOX_UID, SANDBOX_GID } from './docker-driver-constants.js';

export interface ChownLogger {
  info?: (msg: string, meta?: any) => void;
  warn?: (msg: string, meta?: any) => void;
  error?: (msg: string, meta?: any) => void;
}

/**
 * Recursively chown the workspace to the sandbox uid/gid (1001:1001).
 * Called by container drivers before `docker run` so the bind-mounted
 * workspace is owned by the same uid the sandbox process runs as.
 *
 * Best-effort: if the supervisor lacks CAP_CHOWN (common when the
 * supervisor itself runs unprivileged), the chown fails with EPERM
 * and the build inside the sandbox will see EACCES on writes. We
 * warn here so operators can correlate the symptom with the host
 * setup rather than chase a build error.
 *
 * Production deployments solve this by either (a) running the
 * supervisor as root in its own namespace, (b) using rootless Docker
 * with user-namespace remapping, or (c) preparing the workspace
 * directory ownership outside Mergecrew. See
 * docs/03-infrastructure/22-runner-images.md.
 */
export async function chownWorkspaceForSandbox(
  workspacePath: string,
  logger?: ChownLogger,
): Promise<void> {
  const uid = Number(SANDBOX_UID);
  const gid = Number(SANDBOX_GID);
  try {
    await chownTree(workspacePath, uid, gid);
    logger?.info?.('sandbox workspace ownership set', { workspacePath, uid, gid });
  } catch (err: any) {
    const code = err?.code as string | undefined;
    if (code === 'EPERM' || code === 'EACCES') {
      logger?.warn?.(
        'cannot chown workspace to sandbox uid — supervisor lacks CAP_CHOWN. Sandbox writes may EACCES. See docs/03-infrastructure/22-runner-images.md.',
        { workspacePath, code },
      );
      return;
    }
    throw err;
  }
}

async function chownTree(root: string, uid: number, gid: number): Promise<void> {
  // lchown to avoid following symlinks out of the tree.
  await fs.lchown(root, uid, gid);
  const entries = await fs.readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const p = path.join(root, entry.name);
    if (entry.isDirectory()) {
      await chownTree(p, uid, gid);
    } else {
      await fs.lchown(p, uid, gid);
    }
  }
}
