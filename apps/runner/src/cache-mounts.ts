import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { SandboxCacheMount } from '@mergecrew/sandbox-driver';

/**
 * Resolve per-project cache mounts from `runner.cache.paths` (#572).
 *
 * Each declared cache path becomes a `hostPath → containerPath` pair.
 * Host paths are tagged by `(org_id, project_id)` under the cache
 * root so they never cross tenant boundaries; container paths are
 * the literal entries from `mergecrew.yaml` (with `~/` rewritten to
 * the sandbox user's home).
 *
 * Cache root defaults to `/var/mergecrew/cache/`; override via
 * `RUNNER_CACHE_ROOT` env on the supervisor. The supervisor is
 * responsible for creating the host directories before driver.start().
 *
 * GC is out of scope for this PR — operators can prune the cache
 * root via cron (`find /var/mergecrew/cache -atime +30 -delete`)
 * until a first-class TTL/GC lands.
 */

const SANDBOX_HOME = '/home/mergecrew';
const CONTAINER_WORKSPACE = '/workspace';

export function cacheRoot(): string {
  return process.env.RUNNER_CACHE_ROOT ?? '/var/mergecrew/cache';
}

export interface ResolveCacheMountsArgs {
  organizationId: string;
  projectId: string;
  cachePaths: string[] | undefined;
}

export async function resolveCacheMounts(
  args: ResolveCacheMountsArgs,
): Promise<SandboxCacheMount[]> {
  const { organizationId, projectId, cachePaths } = args;
  if (!cachePaths || cachePaths.length === 0) return [];

  const root = cacheRoot();
  const tenantRoot = path.join(root, organizationId, projectId);
  const mounts: SandboxCacheMount[] = [];

  for (const declared of cachePaths) {
    const containerPath = canonicalizeContainerPath(declared);
    const slug = slugify(containerPath);
    const hostPath = path.join(tenantRoot, slug);
    // Best-effort mkdir — let the driver fail visibly if the host can't
    // create the directory rather than silent-skip.
    await fs.mkdir(hostPath, { recursive: true, mode: 0o775 });
    mounts.push({ hostPath, containerPath });
  }
  return mounts;
}

function canonicalizeContainerPath(declared: string): string {
  if (declared.startsWith('~/')) {
    return path.posix.join(SANDBOX_HOME, declared.slice(2));
  }
  if (path.posix.isAbsolute(declared)) {
    return declared;
  }
  return path.posix.join(CONTAINER_WORKSPACE, declared);
}

function slugify(containerPath: string): string {
  // Make a stable, filesystem-safe key — no leading slash so the path
  // isn't accidentally treated as absolute when joined.
  return containerPath.replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^_+/, '');
}
