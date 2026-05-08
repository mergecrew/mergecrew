import type {
  DeployHandle,
  DeployOpts,
  DeployProvider,
  DeployResult,
  DeployStatus,
  DeployTargetRef,
  LogChunk,
} from './types.js';

interface VercelConfig {
  token: string;
}

interface VercelTargetConfig {
  projectId: string;
  teamId?: string;
  target: 'preview' | 'production';
  repoSlug: string; // owner/name
}

export class VercelProvider implements DeployProvider {
  readonly id = 'vercel' as const;
  private token: string;

  constructor(cfg: VercelConfig) {
    this.token = cfg.token;
  }

  private cfgFrom(target: DeployTargetRef): VercelTargetConfig {
    return target.config as unknown as VercelTargetConfig;
  }

  private async api<T = any>(
    path: string,
    init: RequestInit & { query?: Record<string, string> } = {},
  ): Promise<T> {
    const qs = init.query ? '?' + new URLSearchParams(init.query).toString() : '';
    const url = `https://api.vercel.com${path}${qs}`;
    const r = await fetch(url, {
      ...init,
      headers: {
        ...(init.headers ?? {}),
        authorization: `Bearer ${this.token}`,
        'content-type': 'application/json',
      },
    });
    if (!r.ok) throw new Error(`vercel ${r.status}: ${await r.text()}`);
    return (await r.json()) as T;
  }

  async triggerDeploy(target: DeployTargetRef, opts: DeployOpts): Promise<DeployHandle> {
    const cfg = this.cfgFrom(target);
    const body: any = {
      name: cfg.projectId,
      gitSource: {
        type: 'github',
        ref: opts.ref,
        repoId: undefined,
        sha: undefined,
      },
      target: cfg.target,
    };
    if (cfg.repoSlug) {
      const [org, repo] = cfg.repoSlug.split('/');
      body.gitSource = { type: 'github', org, repo, ref: opts.branch };
    }
    if (opts.envOverrides) {
      body.env = Object.entries(opts.envOverrides).map(([k, v]) => ({ key: k, value: v, type: 'plain' }));
    }
    const created = await this.api<{ id: string }>('/v13/deployments', {
      method: 'POST',
      body: JSON.stringify(body),
      query: cfg.teamId ? { teamId: cfg.teamId } : {},
    });
    return { externalRunId: created.id, targetId: target.id, correlationId: opts.correlationId };
  }

  async getStatus(handle: DeployHandle): Promise<DeployStatus> {
    const d = await this.api<any>(`/v13/deployments/${handle.externalRunId}`);
    switch (d.readyState) {
      case 'QUEUED':
        return { kind: 'queued' };
      case 'BUILDING':
      case 'INITIALIZING':
        return { kind: 'in_progress' };
      case 'READY':
        return { kind: 'success', url: `https://${d.url}`, finishedAt: new Date(d.ready ?? Date.now()).toISOString() };
      case 'ERROR':
        return { kind: 'failed', reason: d.errorMessage ?? 'error', finishedAt: new Date().toISOString() };
      case 'CANCELED':
        return { kind: 'cancelled' };
      default:
        return { kind: 'in_progress' };
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
    const list = await this.api<{ deployments: any[] }>('/v6/deployments', {
      query: {
        projectId: cfg.projectId,
        ...(cfg.teamId ? { teamId: cfg.teamId } : {}),
        target: cfg.target,
      },
    });
    const match = list.deployments.find(
      (d) => d.meta?.githubCommitRef === ref || d.meta?.githubCommitSha === ref,
    );
    if (!match) return null;
    return `https://${match.url}`;
  }

  async fetchLogs(handle: DeployHandle, opts: { tailLines?: number }): Promise<LogChunk[]> {
    const events = await this.api<any[]>(`/v3/deployments/${handle.externalRunId}/events`);
    const out: LogChunk[] = events.map((e) => ({
      ts: new Date(e.created ?? Date.now()).toISOString(),
      line: e.text ?? e.payload?.text ?? '',
    }));
    return opts.tailLines ? out.slice(-opts.tailLines) : out;
  }

  async rollbackProduction(target: DeployTargetRef, toRef: string): Promise<DeployHandle> {
    const cfg = this.cfgFrom(target);
    // Promote a previous deployment with sha == toRef.
    const list = await this.api<{ deployments: any[] }>('/v6/deployments', {
      query: {
        projectId: cfg.projectId,
        ...(cfg.teamId ? { teamId: cfg.teamId } : {}),
        target: 'preview',
      },
    });
    const target2 = list.deployments.find((d) => d.meta?.githubCommitSha === toRef);
    if (!target2) throw new Error(`no deployment with sha ${toRef}`);
    await this.api(`/v10/projects/${cfg.projectId}/promote/${target2.uid}`, {
      method: 'POST',
      query: cfg.teamId ? { teamId: cfg.teamId } : {},
    });
    return {
      externalRunId: target2.uid,
      targetId: target.id,
      correlationId: `promote-${target2.uid}`,
    };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, Math.max(0, ms)));
}
