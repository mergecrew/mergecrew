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
        opts.logger.warn(
          'runner is running in unsandboxed mode (process driver) — build steps execute on the host with the supervisor environment. Set RUNNER_SANDBOX=docker for the container-per-run driver. See docs/02-architecture/13-runner-isolation.md',
        );
      }
      return new ProcessDriver();
    case 'docker':
      return new DockerDriver({
        defaultImage: opts.defaultImage,
        ociRuntime: opts.ociRuntime,
        dockerBin: opts.dockerBin,
        logger: opts.logger,
      });
    default:
      throw new Error(`RUNNER_SANDBOX value not recognized: "${raw}". Expected one of: process, docker.`);
  }
}
