import type {
  DeployHandle,
  DeployOpts,
  DeployProvider,
  DeployResult,
  DeployStatus,
  DeployTargetRef,
  LogChunk,
} from './types.js';

interface FlyConfig {
  /**
   * Fly personal access token, scoped per-org. Project-scoped tokens
   * (deploy tokens) work too if the runner only needs that one app.
   */
  token: string;
  /**
   * Optional Machines API base URL override. Defaults to the public
   * \`api.machines.dev/v1\` host. Useful for tests or for running against
   * a Fly proxy in a hardened deployment.
   */
  endpoint?: string;
}

interface FlyTargetConfig {
  /** App name as it appears in Fly's dashboard / DNS (\`<appName>.fly.dev\`). */
  appName: string;
  /**
   * Image registry path. \`{sha}\` is replaced with \`opts.ref\` at trigger
   * time. Defaults to \`registry.fly.io/<appName>:{sha}\` — operators
   * pushing to a different registry override here.
   */
  imageTemplate?: string;
  /**
   * Optional region hint passed to the per-machine deploy. Falls back
   * to whatever Fly assigned the machine when it was created.
   */
  region?: string;
  /**
   * Optional public URL override. Defaults to \`https://<appName>.fly.dev\`.
   */
  publicUrl?: string;
}

/**
 * Fly.io deploy provider (#199).
 *
 * Fly's deploy model is **image-based**: \`flyctl deploy\` builds a
 * Docker image, pushes it to \`registry.fly.io\`, and updates each
 * machine's config to point at the new image. There's no API-side
 * "deploy from a git ref" — the build half lives outside the adapter.
 *
 * Compromise this adapter takes:
 *  - The operator's CI is responsible for building + pushing
 *    \`registry.fly.io/<appName>:<sha>\` (mirrors the convention
 *    \`flyctl deploy\` uses).
 *  - The adapter's \`triggerDeploy\` enumerates the app's machines
 *    via the Machines API and updates each machine's config to point
 *    at the SHA-tagged image. Fly performs a rolling update.
 *  - The handle's \`externalRunId\` is the SHA — we use it to query
 *    machine status during \`getStatus\`.
 *
 * State mapping:
 *   any machine still updating          → in_progress
 *   all machines healthy and on the SHA → success
 *   any machine on a worse state        → failed
 *
 * URL resolution: defaults to \`https://<appName>.fly.dev\`. Operators
 * with custom domains override via \`config.publicUrl\`.
 *
 * What this adapter intentionally does NOT do:
 *  - Build or push images. That's CI's job.
 *  - Manage scale or machine lifecycle beyond image updates.
 *  - Use the deprecated GraphQL release path. Machines is the
 *    canonical surface today.
 */
export class FlyProvider implements DeployProvider {
  readonly id = 'fly' as const;
  private token: string;
  private endpoint: string;

  constructor(cfg: FlyConfig) {
    this.token = cfg.token;
    this.endpoint = cfg.endpoint ?? 'https://api.machines.dev/v1';
  }

  private cfgFrom(target: DeployTargetRef): FlyTargetConfig {
    return target.config as unknown as FlyTargetConfig;
  }

  private imageRef(cfg: FlyTargetConfig, sha: string): string {
    const tpl = cfg.imageTemplate ?? `registry.fly.io/${cfg.appName}:{sha}`;
    return tpl.replace(/\{sha\}/g, sha);
  }

  private async api<T = any>(path: string, init: RequestInit = {}): Promise<T> {
    const r = await fetch(`${this.endpoint}${path}`, {
      ...init,
      headers: {
        ...(init.headers ?? {}),
        authorization: `Bearer ${this.token}`,
        accept: 'application/json',
        'content-type': 'application/json',
      },
    });
    if (!r.ok) throw new Error(`fly ${r.status}: ${await r.text()}`);
    if (r.status === 204) return undefined as T;
    const text = await r.text();
    if (!text) return undefined as T;
    return JSON.parse(text) as T;
  }

  async triggerDeploy(target: DeployTargetRef, opts: DeployOpts): Promise<DeployHandle> {
    const cfg = this.cfgFrom(target);
    if (!opts.ref) {
      throw new Error('fly: opts.ref must carry a SHA — Fly deploys are image-based and the image tag is derived from the SHA');
    }
    const machines = await this.api<Array<{ id: string; config: any }>>(
      `/apps/${encodeURIComponent(cfg.appName)}/machines`,
    );
    if (machines.length === 0) {
      throw new Error(`fly: app ${cfg.appName} has no machines — create one before deploying`);
    }
    const image = this.imageRef(cfg, opts.ref);
    // Roll the image change to every machine. The Machines API is
    // per-machine; Fly itself doesn't expose a "deploy" abstraction.
    for (const m of machines) {
      await this.api(`/apps/${encodeURIComponent(cfg.appName)}/machines/${m.id}`, {
        method: 'POST',
        body: JSON.stringify({
          config: { ...m.config, image },
          ...(cfg.region ? { region: cfg.region } : {}),
        }),
      });
    }
    return {
      // Fly has no per-deploy id; the SHA is the most stable handle we
      // can use for downstream status / URL queries against this app.
      externalRunId: opts.ref,
      targetId: target.id,
      correlationId: opts.correlationId,
    };
  }

  async getStatus(handle: DeployHandle): Promise<DeployStatus> {
    // Status is reconstructed from the app's machines: which image
    // they're running and what state they're in.
    const cfg = await this.cfgForHandle(handle);
    if (!cfg) return { kind: 'queued' };
    const targetImage = this.imageRef(cfg, handle.externalRunId);

    let machines: Array<{ id: string; state: string; config: { image: string } }>;
    try {
      machines = await this.api(`/apps/${encodeURIComponent(cfg.appName)}/machines`);
    } catch {
      return { kind: 'queued' };
    }
    if (machines.length === 0) return { kind: 'queued' };

    const onTarget = machines.filter((m) => m.config?.image === targetImage);
    const inflight = machines.filter((m) =>
      m.config?.image !== targetImage || ['starting', 'created', 'replacing'].includes(m.state),
    );
    if (machines.every((m) => m.config?.image === targetImage && m.state === 'started')) {
      return {
        kind: 'success',
        url: cfg.publicUrl ?? `https://${cfg.appName}.fly.dev`,
        finishedAt: new Date().toISOString(),
      };
    }
    if (onTarget.some((m) => m.state === 'failed' || m.state === 'destroyed')) {
      return {
        kind: 'failed',
        reason: 'machine_failed',
        finishedAt: new Date().toISOString(),
      };
    }
    if (inflight.length > 0) {
      return { kind: 'in_progress' };
    }
    return { kind: 'queued' };
  }

  async awaitCompletion(
    handle: DeployHandle,
    timeoutMs: number,
    abort: AbortSignal,
  ): Promise<DeployResult> {
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

  async resolveUrlForRef(target: DeployTargetRef, _ref: string): Promise<string | null> {
    const cfg = this.cfgFrom(target);
    return cfg.publicUrl ?? `https://${cfg.appName}.fly.dev`;
  }

  async fetchLogs(_handle: DeployHandle, _opts: { tailLines?: number }): Promise<LogChunk[]> {
    // Fly's logs ship via NATS / a dedicated streaming endpoint that
    // requires a long-lived connection — operators should tail in the
    // Fly dashboard or via \`flyctl logs\`. Returning empty matches the
    // Render and Netlify adapters.
    return [];
  }

  async rollbackProduction(target: DeployTargetRef, toRef: string): Promise<DeployHandle> {
    return this.triggerDeploy(target, {
      ref: toRef,
      branch: this.cfgFrom(target).appName,
      correlationId: `rollback-${toRef}-${Date.now()}`,
    });
  }

  // ─── handle context ─────────────────────────────────────────────────────

  /**
   * \`getStatus\` only receives the handle, not the original target — but
   * Fly status is reconstructed from the app's machines, so we need
   * the appName. Callers register the route immediately after
   * triggerDeploy (mirrors the GitHub Actions adapter pattern).
   */
  static rememberRoute(externalRunId: string, cfg: FlyTargetConfig): void {
    handleRoutes.set(externalRunId, cfg);
  }

  private async cfgForHandle(handle: DeployHandle): Promise<FlyTargetConfig | null> {
    return handleRoutes.get(handle.externalRunId) ?? null;
  }
}

const handleRoutes = new Map<string, FlyTargetConfig>();

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, Math.max(0, ms)));
}
