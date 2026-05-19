import type { SandboxDriver } from './types.js';
import { ProcessDriver } from './process-driver.js';
import { DockerDriver } from './docker-driver.js';
import { K8sDriver } from './k8s-driver.js';
import { buildK8sApiClient } from './k8s-api-client.js';

export type SandboxMode = 'process' | 'docker' | 'kubernetes';

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
  /** IPv4 of the runner-dns resolver. From RUNNER_DNS_RESOLVER. */
  dnsResolver?: string;
  /** Kubernetes namespace where the K8sDriver creates Jobs. From RUNNER_K8S_NAMESPACE. */
  k8sNamespace?: string;
  /** 'default' (kubeconfig) or 'in-cluster'. From RUNNER_K8S_AUTH. */
  k8sAuth?: 'default' | 'in-cluster';
  /** Image used by the K8sDriver when no per-project image is set. From RUNNER_K8S_DEFAULT_IMAGE. */
  k8sDefaultImage?: string;
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
export async function buildSandboxDriverAsync(opts: SandboxFactoryOpts = {}): Promise<SandboxDriver> {
  const raw = (opts.mode ?? 'process').trim().toLowerCase();
  if (raw === 'kubernetes' || raw === 'k8s') {
    if (!opts.k8sNamespace) {
      throw new Error('RUNNER_K8S_NAMESPACE is required when RUNNER_SANDBOX=kubernetes');
    }
    const api = await buildK8sApiClient({ kubeConfigLoader: opts.k8sAuth ?? 'default' });
    opts.logger?.info(
      `sandbox driver: kubernetes (ns=${opts.k8sNamespace})`,
      { event: 'runner.sandbox_mode', mode: 'kubernetes' },
    );
    return new K8sDriver({
      api,
      namespace: opts.k8sNamespace,
      defaultImage: opts.k8sDefaultImage ?? opts.defaultImage,
      logger: opts.logger,
    });
  }
  return buildSandboxDriver(opts);
}

export function buildSandboxDriver(opts: SandboxFactoryOpts = {}): SandboxDriver {
  const raw = (opts.mode ?? 'process').trim().toLowerCase();
  if (raw === 'kubernetes' || raw === 'k8s') {
    throw new Error(
      'RUNNER_SANDBOX=kubernetes requires buildSandboxDriverAsync() (loads @kubernetes/client-node lazily).',
    );
  }
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
        dnsResolver: opts.dnsResolver,
        logger: opts.logger,
      });
    default:
      throw new Error(
        `RUNNER_SANDBOX value not recognized: "${raw}". Expected one of: process, docker, kubernetes.`,
      );
  }
}
