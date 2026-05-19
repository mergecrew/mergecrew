import type { SandboxDriver } from './types.js';
import { ProcessDriver } from './process-driver.js';
import { DockerDriver } from './docker-driver.js';

export type SandboxMode = 'process' | 'docker';

export interface SandboxFactoryOpts {
  /** Value of process.env.RUNNER_SANDBOX. Defaults to `process`. */
  mode?: string;
  /** Default image for the docker driver. From RUNNER_DEFAULT_IMAGE. */
  defaultImage?: string;
  /** OCI runtime for the docker driver. From RUNNER_OCI_RUNTIME. */
  ociRuntime?: string;
  /** Docker CLI binary; supports `podman` for rootless setups. From RUNNER_DOCKER_BIN. */
  dockerBin?: string;
  /** Docker network used when an egress allowlist is set. From RUNNER_EGRESS_NETWORK. */
  egressNetwork?: string;
  logger?: {
    info: (msg: string, meta?: any) => void;
    warn: (msg: string, meta?: any) => void;
    error: (msg: string, meta?: any) => void;
  };
}

/**
 * Resolve the configured sandbox driver. Defaults to `process` (today's
 * behavior). Unknown modes throw so a typo doesn't silently fall back
 * to the unsandboxed default.
 */
export function buildSandboxDriver(opts: SandboxFactoryOpts = {}): SandboxDriver {
  const raw = (opts.mode ?? 'process').trim().toLowerCase();
  switch (raw) {
    case '':
    case 'process':
      if (opts.logger) {
        // Multi-line banner is intentional — this is a security-relevant
        // posture choice the operator should not miss in a busy log
        // stream. Suppressing it requires explicitly switching modes.
        opts.logger.warn(
          [
            '',
            '┌───────────────────────────────────────────────────────────────────┐',
            '│  UNSANDBOXED RUNNER MODE (process driver)                         │',
            '│                                                                   │',
            '│  Build steps run on the supervisor host. The env scrub (#561)     │',
            '│  prevents supervisor secrets from leaking, but FS / network /     │',
            '│  resource isolation are NOT enforced.                             │',
            '│                                                                   │',
            '│  Set RUNNER_SANDBOX=docker for per-run container isolation.       │',
            '│  See docs/03-infrastructure/16-self-host-runbook.md               │',
            '│    § Enable RUNNER_SANDBOX=docker                                 │',
            '└───────────────────────────────────────────────────────────────────┘',
            '',
          ].join('\n'),
          { event: 'runner.sandbox_mode', mode: 'process' },
        );
      }
      return new ProcessDriver({ logger: opts.logger });
    case 'docker':
      opts.logger?.info(
        'sandbox driver: docker (per-run container isolation enabled)',
        { event: 'runner.sandbox_mode', mode: 'docker' },
      );
      return new DockerDriver({
        defaultImage: opts.defaultImage,
        ociRuntime: opts.ociRuntime,
        dockerBin: opts.dockerBin,
        egressNetwork: opts.egressNetwork,
        logger: opts.logger,
      });
    default:
      throw new Error(`RUNNER_SANDBOX value not recognized: "${raw}". Expected one of: process, docker.`);
  }
}
