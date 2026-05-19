import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { Logger } from 'pino';
import type { SandboxDriver, SandboxHandle } from '@mergecrew/sandbox-driver';

/**
 * Workspace tool-version bootstrap (#568).
 *
 * When the cloned repo contains a `.tool-versions` (asdf/mise format)
 * or `.mise.toml`, run `mise install` once per workspace so the
 * agent's shell skills see the project's pinned Node/Python/Go/Java/
 * Ruby/Rust versions. The sentinel file `.mergecrew-mise-installed`
 * inside the workspace caches the hash of whichever file drove the
 * install — re-running `mise install` is otherwise idempotent but
 * costs ~1s per call, and a daily run with 10+ steps would burn that
 * unnecessarily.
 *
 * Stays a no-op when:
 *  - neither file exists in the workspace root
 *  - the workspace has already been bootstrapped at the current hash
 *  - mise is not on PATH inside the sandbox (older custom images)
 */

const SENTINEL = '.mergecrew-mise-installed';
const TOOL_VERSIONS = '.tool-versions';
const MISE_TOML = '.mise.toml';

export interface MaybeRunMiseInstallArgs {
  workspacePath: string;
  driver: SandboxDriver;
  sandbox: SandboxHandle;
  logger: Logger;
  abortSignal?: AbortSignal;
}

export type MiseInstallOutcome =
  | { kind: 'skipped'; reason: 'no_versions_file' | 'cached' | 'mise_not_available' }
  | { kind: 'installed'; durationMs: number }
  | { kind: 'failed'; durationMs: number; exitCode: number; stderr: string };

export async function maybeRunMiseInstall(
  args: MaybeRunMiseInstallArgs,
): Promise<MiseInstallOutcome> {
  const { workspacePath, driver, sandbox, logger, abortSignal } = args;

  const versionsFile = await pickVersionsFile(workspacePath);
  if (!versionsFile) {
    return { kind: 'skipped', reason: 'no_versions_file' };
  }
  const fileHash = await hashFile(path.join(workspacePath, versionsFile));
  const sentinelPath = path.join(workspacePath, SENTINEL);
  const cachedHash = await readSentinel(sentinelPath);
  if (cachedHash === fileHash) {
    return { kind: 'skipped', reason: 'cached' };
  }

  // Probe mise. Old / BYO images may not have it; skip silently rather
  // than fail the run — `runner.image` operators are expected to
  // install their own tooling.
  const probe = await driver.exec(sandbox, {
    cmd: 'sh',
    args: ['-c', 'command -v mise >/dev/null 2>&1'],
    signal: abortSignal,
    timeoutMs: 5_000,
  });
  if (probe.exitCode !== 0) {
    logger.info({ workspacePath }, 'mise not available in sandbox image; skipping .tool-versions install');
    return { kind: 'skipped', reason: 'mise_not_available' };
  }

  const t0 = Date.now();
  const result = await driver.exec(sandbox, {
    cmd: 'mise',
    args: ['install'],
    signal: abortSignal,
    timeoutMs: 10 * 60 * 1000,
  });
  const durationMs = Date.now() - t0;
  if (result.exitCode !== 0) {
    logger.warn(
      {
        workspacePath,
        versionsFile,
        durationMs,
        exitCode: result.exitCode,
        stderr: tail(result.stderr, 2000),
      },
      'mise install failed',
    );
    return { kind: 'failed', durationMs, exitCode: result.exitCode, stderr: result.stderr };
  }

  await fs.writeFile(sentinelPath, fileHash, 'utf8');
  logger.info(
    { workspacePath, versionsFile, durationMs },
    'mise install: ok',
  );
  return { kind: 'installed', durationMs };
}

async function pickVersionsFile(workspacePath: string): Promise<string | null> {
  for (const candidate of [MISE_TOML, TOOL_VERSIONS]) {
    try {
      await fs.access(path.join(workspacePath, candidate));
      return candidate;
    } catch {
      /* not present */
    }
  }
  return null;
}

async function hashFile(file: string): Promise<string> {
  const buf = await fs.readFile(file);
  return createHash('sha256').update(buf).digest('hex');
}

async function readSentinel(file: string): Promise<string | null> {
  try {
    const buf = await fs.readFile(file, 'utf8');
    return buf.trim() || null;
  } catch {
    return null;
  }
}

function tail(s: string, max: number): string {
  return s.length <= max ? s : s.slice(s.length - max);
}
