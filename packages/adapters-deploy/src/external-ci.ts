import type {
  DeployHandle,
  DeployOpts,
  DeployProvider,
  DeployResult,
  DeployStatus,
  DeployTargetRef,
  LogChunk,
} from './types.js';

interface ExternalCiTargetConfig {
  /**
   * Preview URL the user's external CI/CD publishes to for this kind.
   * For dev, typically `https://dev.example.com`; supports `${branch}`
   * / `${sha}` placeholders for per-branch preview hosts.
   */
  urlFixed?: string;
  urlPattern?: string;
}

/**
 * External-CI adapter (#467).
 *
 * For teams whose CI/CD is already wired up outside mergecrew — push to
 * `main` triggers their existing GitHub Actions / GitLab CI / Jenkins /
 * Argo pipeline, which deploys to a stable preview URL. mergecrew does
 * not need to dispatch builds; it just needs to know where the build
 * will be reachable so downstream skills (smoke tests, screenshot diff)
 * have a target.
 *
 * Semantics: triggerDeploy is a no-op that returns success immediately
 * with the resolved URL. The runner treats this as "deploy completed"
 * for orchestration purposes — the assumption is the user's existing
 * pipeline will have raced ahead by the time downstream steps need the
 * URL. (Teams that need stricter sequencing should use the
 * `github-actions` adapter in `observe` mode instead.)
 */
export class ExternalCiProvider implements DeployProvider {
  readonly id = 'external-ci' as const;

  private cfgFrom(target: DeployTargetRef): ExternalCiTargetConfig {
    return target.config as unknown as ExternalCiTargetConfig;
  }

  private resolveUrl(target: DeployTargetRef, opts: { ref?: string; branch?: string }): string {
    const cfg = this.cfgFrom(target);
    if (cfg.urlPattern) {
      return cfg.urlPattern
        .replace(/\$\{branch\}/g, opts.branch ?? '')
        .replace(/\$\{sha\}/g, opts.ref ?? '');
    }
    return cfg.urlFixed ?? '';
  }

  async triggerDeploy(target: DeployTargetRef, opts: DeployOpts): Promise<DeployHandle> {
    return {
      externalRunId: `external-ci-${opts.correlationId}`,
      targetId: target.id,
      correlationId: opts.correlationId,
    };
  }

  async getStatus(handle: DeployHandle): Promise<DeployStatus> {
    return {
      kind: 'success',
      url: '',
      finishedAt: new Date().toISOString(),
    };
  }

  async awaitCompletion(
    handle: DeployHandle,
    _timeoutMs: number,
    _abort: AbortSignal,
  ): Promise<DeployResult> {
    return {
      status: {
        kind: 'success',
        url: '',
        finishedAt: new Date().toISOString(),
      },
    };
  }

  async resolveUrlForRef(target: DeployTargetRef, ref: string): Promise<string | null> {
    const url = this.resolveUrl(target, { ref });
    return url || null;
  }

  async fetchLogs(_handle: DeployHandle, _opts: { tailLines?: number }): Promise<LogChunk[]> {
    return [];
  }

  async rollbackProduction(target: DeployTargetRef, _toRef: string): Promise<DeployHandle> {
    return {
      externalRunId: `external-ci-rollback-${target.id}`,
      targetId: target.id,
      correlationId: `external-ci-rollback-${target.id}`,
    };
  }
}
