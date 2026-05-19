import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { Logger } from 'pino';
import type { SandboxDriver, SandboxHandle } from '@mergecrew/sandbox-driver';

/**
 * Per-workspace setup commands (#572). The project's `runner.setup`
 * array runs once per workspace via the SandboxDriver before the
 * first agent step touches the repo. Sentinel-deduped on the SHA-256
 * of the command list so re-running the same setup is free; editing
 * the array bumps the sentinel and forces a re-run.
 *
 * Each entry is shelled via `/bin/sh -c`. Operators get the same
 * shell semantics they have in CI scripts (pipes, redirects, env
 * substitution against the scrubbed sandbox env).
 */

const SENTINEL = '.mergecrew-setup-installed';

export interface MaybeRunSetupArgs {
  workspacePath: string;
  driver: SandboxDriver;
  sandbox: SandboxHandle;
  setup: string[] | undefined;
  logger: Logger;
  abortSignal?: AbortSignal;
}

export type SetupOutcome =
  | { kind: 'no_setup' }
  | { kind: 'cached' }
  | { kind: 'ran'; durationMs: number }
  | { kind: 'failed'; durationMs: number; command: string; exitCode: number; stderr: string };

export async function maybeRunSetup(args: MaybeRunSetupArgs): Promise<SetupOutcome> {
  const { workspacePath, driver, sandbox, setup, logger, abortSignal } = args;
  if (!setup || setup.length === 0) return { kind: 'no_setup' };

  const sentinelPath = path.join(workspacePath, SENTINEL);
  const setupHash = hashSetup(setup);
  const cachedHash = await readSentinel(sentinelPath);
  if (cachedHash === setupHash) return { kind: 'cached' };

  const t0 = Date.now();
  for (const command of setup) {
    const r = await driver.exec(sandbox, {
      cmd: 'sh',
      args: ['-c', command],
      signal: abortSignal,
      timeoutMs: 10 * 60 * 1000,
    });
    if (r.exitCode !== 0) {
      const durationMs = Date.now() - t0;
      logger.warn(
        { workspacePath, command, exitCode: r.exitCode, durationMs, stderr: tail(r.stderr, 2000) },
        'runner.setup command failed',
      );
      return {
        kind: 'failed',
        durationMs,
        command,
        exitCode: r.exitCode,
        stderr: r.stderr,
      };
    }
  }

  const durationMs = Date.now() - t0;
  await fs.writeFile(sentinelPath, setupHash, 'utf8');
  logger.info({ workspacePath, count: setup.length, durationMs }, 'runner.setup: ok');
  return { kind: 'ran', durationMs };
}

function hashSetup(setup: string[]): string {
  return createHash('sha256').update(setup.join('\n')).digest('hex');
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
