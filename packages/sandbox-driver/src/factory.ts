import type { SandboxDriver } from './types.js';
import { ProcessDriver } from './process-driver.js';

export type SandboxMode = 'process' | 'docker';

export interface SandboxFactoryOpts {
  /** Value of process.env.RUNNER_SANDBOX. Defaults to `process`. */
  mode?: string;
  logger?: { info: (msg: string, meta?: any) => void; warn: (msg: string, meta?: any) => void };
}

/**
 * Resolve the configured sandbox driver. Defaults to `process` (today's
 * behavior). `docker` is wired in #557. Anything else throws so a
 * typo doesn't silently fall back to the unsandboxed mode.
 */
export function buildSandboxDriver(opts: SandboxFactoryOpts = {}): SandboxDriver {
  const raw = (opts.mode ?? 'process').trim().toLowerCase();
  switch (raw) {
    case '':
    case 'process':
      if (opts.logger) {
        opts.logger.warn(
          'runner is running in unsandboxed mode (process driver) — build steps execute on the host with the supervisor environment. Set RUNNER_SANDBOX=docker once #557 ships. See docs/02-architecture/13-runner-isolation.md',
        );
      }
      return new ProcessDriver();
    case 'docker':
      throw new Error('RUNNER_SANDBOX=docker is not implemented yet — tracked in #557');
    default:
      throw new Error(`RUNNER_SANDBOX value not recognized: "${raw}". Expected one of: process, docker.`);
  }
}
