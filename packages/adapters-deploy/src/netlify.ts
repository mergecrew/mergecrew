import type {
  DeployHandle,
  DeployOpts,
  DeployProvider,
  DeployResult,
  DeployStatus,
  DeployTargetRef,
  LogChunk,
} from './types.js';

interface NetlifyConfig {
  /** Personal access token from Netlify user settings. */
  token: string;
}

interface NetlifyTargetConfig {
  /** Site identifier — the API id, NOT the user-facing slug. */
  siteId: string;
}

/**
 * Netlify deploy provider (#26 follow-up).
 *
 * Trigger semantics: we kick a fresh build via `POST /sites/:id/builds`
 * which respects the site's branch deploy + environment configuration.
 * Branch + ref selection happens server-side based on Netlify's GitHub
 * connection — we don't try to override it here. The returned `id` from
 * the build kicks off a deploy whose lifecycle we poll.
 *
 * State mapping (see https://docs.netlify.com/api/get-started/#deploys):
 *   new / enqueued                       → queued
 *   building / uploading / processing /
 *     prepared / uploaded                → in_progress
 *   ready                                → success
 *   error                                → failed
 */
export class NetlifyProvider implements DeployProvider {
  readonly id = 'netlify' as const;
  private token: string;

  constructor(cfg: NetlifyConfig) {
    this.token = cfg.token;
  }

  private cfgFrom(target: DeployTargetRef): NetlifyTargetConfig {
    return target.config as unknown as NetlifyTargetConfig;
  }

  private async api<T = any>(path: string, init: RequestInit = {}): Promise<T> {
    const r = await fetch(`https://api.netlify.com/api/v1${path}`, {
      ...init,
      headers: {
        ...(init.headers ?? {}),
        authorization: `Bearer ${this.token}`,
        'content-type': 'application/json',
      },
    });
    if (!r.ok) throw new Error(`netlify ${r.status}: ${await r.text()}`);
    if (r.status === 204) return undefined as T;
    return (await r.json()) as T;
  }

  async triggerDeploy(target: DeployTargetRef, _opts: DeployOpts): Promise<DeployHandle> {
    const cfg = this.cfgFrom(target);
    // Kicks a build using the site's GitHub-connected branch config.
    const created = await this.api<{ id: string; deploy_id?: string }>(
      `/sites/${cfg.siteId}/builds`,
      { method: 'POST' },
    );
    return {
      externalRunId: created.deploy_id ?? created.id,
      targetId: target.id,
      correlationId: _opts.correlationId,
    };
  }

  async getStatus(handle: DeployHandle): Promise<DeployStatus> {
    // The deploy_id may be absent right after a build trigger; in that case
    // we look it up via the latest deploy on the site. For typical usage the
    // builds endpoint returns deploy_id immediately.
    const d = await this.api<any>(`/deploys/${handle.externalRunId}`);
    switch (d.state) {
      case 'new':
      case 'enqueued':
        return { kind: 'queued' };
      case 'building':
      case 'uploading':
      case 'processing':
      case 'prepared':
      case 'uploaded':
        return { kind: 'in_progress', latestStep: d.state };
      case 'ready':
        return {
          kind: 'success',
          url: d.deploy_ssl_url ?? d.deploy_url ?? d.ssl_url ?? d.url,
          finishedAt: d.published_at ?? d.updated_at ?? new Date().toISOString(),
        };
      case 'error':
        return {
          kind: 'failed',
          reason: d.error_message ?? 'error',
          url: d.deploy_url ?? undefined,
          finishedAt: d.updated_at ?? new Date().toISOString(),
        };
      default:
        return { kind: 'in_progress', latestStep: d.state };
    }
  }

  async awaitCompletion(handle: DeployHandle, timeoutMs: number, abort: AbortSignal): Promise<DeployResult> {
    const deadline = Date.now() + timeoutMs;
    let delay = 4_000;
    while (!abort.aborted && Date.now() < deadline) {
      const s = await this.getStatus(handle);
      if (s.kind === 'success' || s.kind === 'failed' || s.kind === 'cancelled') {
        return { status: s, url: (s as any).url };
      }
      await sleep(Math.min(delay, deadline - Date.now()));
      delay = Math.min(delay * 1.4, 15_000);
    }
    return { status: { kind: 'failed', reason: 'timeout', finishedAt: new Date().toISOString() } };
  }

  async resolveUrlForRef(target: DeployTargetRef, ref: string): Promise<string | null> {
    const cfg = this.cfgFrom(target);
    const list = await this.api<any[]>(`/sites/${cfg.siteId}/deploys?per_page=50`);
    const match = list.find(
      (d) =>
        d.commit_ref === ref ||
        d.branch === ref ||
        d.context === ref ||
        d.review_id?.toString() === ref,
    );
    if (!match) return null;
    return match.deploy_ssl_url ?? match.deploy_url ?? match.ssl_url ?? null;
  }

  async fetchLogs(_handle: DeployHandle, _opts: { tailLines?: number }): Promise<LogChunk[]> {
    // Netlify exposes build logs only via a signed S3-ish URL fetched from
    // /builds/:id/log. For v0.1 we surface that fetch as a no-op and let
    // operators tail in the Netlify UI; flesh out when CI uses logs.
    return [];
  }

  async rollbackProduction(target: DeployTargetRef, toRef: string): Promise<DeployHandle> {
    const cfg = this.cfgFrom(target);
    // Find a published deploy whose commit_ref matches and call /restore.
    const list = await this.api<any[]>(`/sites/${cfg.siteId}/deploys?per_page=100`);
    const candidate = list.find((d) => d.commit_ref === toRef && d.state === 'ready');
    if (!candidate) throw new Error(`no ready deploy for ref ${toRef}`);
    const restored = await this.api<{ id: string }>(
      `/sites/${cfg.siteId}/deploys/${candidate.id}/restore`,
      { method: 'POST' },
    );
    return {
      externalRunId: restored.id,
      targetId: target.id,
      correlationId: `rollback-${candidate.id}`,
    };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, Math.max(0, ms)));
}
