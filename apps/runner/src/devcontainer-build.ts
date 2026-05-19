import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { Logger } from 'pino';

const defaultExecFileAsync = promisify(execFile);

/** Seam for tests — production uses promisified `node:child_process` execFile. */
export type ExecFileAsync = (
  cmd: string,
  args: string[],
  opts?: { timeout?: number; maxBuffer?: number },
) => Promise<{ stdout: string; stderr: string }>;

/**
 * `.devcontainer/devcontainer.json` resolution (#570).
 *
 * When a project ships a devcontainer config, the supervisor builds
 * it into an OCI image via `@devcontainers/cli` and uses that image
 * for the sandbox driver. Cached on the host keyed by the SHA-256 of
 * the config file — re-runs of the same revision skip the build.
 *
 * The build process needs:
 *   - the supervisor host to have a docker socket (same requirement
 *     as the docker SandboxDriver itself)
 *   - network access to pull the devcontainer base image + features
 *   - `npx`/`node` on PATH (the CLI installs itself via npx -y)
 *
 * Stays a no-op when:
 *   - no `.devcontainer/devcontainer.json` is present
 *   - the supervisor lacks the runtime ingredients above (failures
 *     fall back to the stock catalog rather than blocking the run)
 */

const DEVCONTAINER_PATH = path.join('.devcontainer', 'devcontainer.json');
const DEVCONTAINER_BUILD_TIMEOUT_MS = 15 * 60 * 1000;

export interface MaybeBuildDevcontainerArgs {
  workspacePath: string;
  logger: Logger;
  /** Override the docker binary; defaults to `docker`. */
  dockerBin?: string;
  /** Override the devcontainer CLI invocation (used in tests). */
  npxBin?: string;
  /** Inject a fake execFile for tests. */
  execFileAsync?: ExecFileAsync;
}

export type DevcontainerBuildOutcome =
  | { kind: 'no_devcontainer' }
  | { kind: 'cached'; image: string }
  | { kind: 'built'; image: string; durationMs: number }
  | { kind: 'failed'; reason: string };

export async function maybeBuildDevcontainer(
  args: MaybeBuildDevcontainerArgs,
): Promise<DevcontainerBuildOutcome> {
  const { workspacePath, logger } = args;
  const dockerBin = args.dockerBin ?? 'docker';
  const npxBin = args.npxBin ?? 'npx';
  const execFn: ExecFileAsync = args.execFileAsync ?? defaultExecFileAsync;

  const configPath = path.join(workspacePath, DEVCONTAINER_PATH);
  let configBytes: Buffer;
  try {
    configBytes = await fs.readFile(configPath);
  } catch {
    return { kind: 'no_devcontainer' };
  }

  const hash = createHash('sha256').update(configBytes).digest('hex').slice(0, 16);
  const imageRef = `mergecrew-devcontainer:${hash}`;

  // Cache hit? `docker image inspect` returns 0 + a JSON body when the
  // image exists, non-zero otherwise.
  let cached = false;
  try {
    const probe = await execFn(dockerBin, ['image', 'inspect', imageRef]);
    if (probe.stdout && probe.stdout.trim().length > 0) {
      cached = true;
    }
  } catch {
    /* not cached */
  }
  if (cached) {
    logger.info({ workspacePath, image: imageRef }, 'devcontainer image cached; skipping build');
    return { kind: 'cached', image: imageRef };
  }

  // Build via @devcontainers/cli. `npx -y` installs the CLI on first
  // invocation; subsequent runs reuse the supervisor's npm cache.
  const t0 = Date.now();
  try {
    await execFn(
      npxBin,
      [
        '-y',
        '@devcontainers/cli',
        'build',
        '--image-name',
        imageRef,
        '--workspace-folder',
        workspacePath,
      ],
      { timeout: DEVCONTAINER_BUILD_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 },
    );
  } catch (err: any) {
    const reason =
      err?.code === 'ENOENT'
        ? `devcontainer build: ${npxBin} not on PATH on the supervisor host`
        : `devcontainer build failed: ${String(err?.stderr ?? err?.message ?? err).slice(0, 1000)}`;
    logger.warn({ workspacePath, configPath, reason }, 'devcontainer build failed; falling back to stack image');
    return { kind: 'failed', reason };
  }

  const durationMs = Date.now() - t0;
  logger.info({ workspacePath, image: imageRef, durationMs }, 'devcontainer image built');
  return { kind: 'built', image: imageRef, durationMs };
}
