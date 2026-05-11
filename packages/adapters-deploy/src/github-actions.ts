import { createAppAuth } from '@octokit/auth-app';
import { Octokit } from '@octokit/rest';
import type {
  DeployHandle,
  DeployOpts,
  DeployProvider,
  DeployResult,
  DeployStatus,
  DeployTargetRef,
  LogChunk,
} from './types.js';

interface GhActionsConfig {
  appId: string;
  privateKey: string;
}

interface GhTargetConfig {
  installationId: string;
  repoFullName: string;
  workflowFilename: string;
  inputsTemplate: Record<string, string>;
  urlResolution: 'workflow_output' | 'pattern' | 'fixed';
  urlPattern?: string;
  urlFixed?: string;
  /**
   * - `'dispatch'` (default): Mergecrew calls `workflowDispatch` to start
   *   the deploy. Suits manual-button workflows (typical for prod).
   * - `'observe'`: Mergecrew does **not** dispatch; instead it waits for
   *   the operator's existing push/pull-request triggered run to appear
   *   and watches it. Suits "merge to main → CI auto-deploys" repos.
   */
  triggerMode?: 'dispatch' | 'observe';
  /**
   * How long to wait for the operator's CI to produce a matching run
   * before giving up in `observe` mode (ms). GitHub Actions typically
   * queues a run within a few seconds of the push; the default 60s
   * covers cold-runner / queue lag without hanging Mergecrew forever.
   */
  observeFindTimeoutMs?: number;
}

/**
 * GitHub Actions deploy adapter. Supports two trigger modes:
 *
 *   `triggerMode: 'dispatch'` (default)
 *     Mergecrew calls `workflowDispatch` to start the deploy. Suits
 *     manual-button workflows — typical for production where the
 *     operator wants an explicit gate.
 *
 *   `triggerMode: 'observe'` (#259)
 *     Mergecrew does **not** dispatch. It waits for the operator's
 *     existing push/pull-request triggered workflow run to appear on
 *     the agent-pushed branch and watches it. Suits the common
 *     "merge to main → CI auto-deploys" pattern; this is the path
 *     to use when a real repo already has dev deploys wired up.
 *
 * Both modes return the same `DeployHandle` shape — only the trigger
 * semantics differ. The downstream `getStatus` / `awaitCompletion` /
 * `fetchLogs` calls are identical.
 */
export class GitHubActionsProvider implements DeployProvider {
  readonly id = 'github-actions' as const;
  private auth: ReturnType<typeof createAppAuth>;

  constructor(cfg: GhActionsConfig) {
    this.auth = createAppAuth({ appId: cfg.appId, privateKey: cfg.privateKey });
  }

  private async kit(installationId: string): Promise<Octokit> {
    const r: any = await this.auth({ type: 'installation', installationId: Number(installationId) });
    return new Octokit({ auth: r.token });
  }

  private cfgFrom(target: DeployTargetRef): GhTargetConfig {
    return target.config as unknown as GhTargetConfig;
  }

  async triggerDeploy(target: DeployTargetRef, opts: DeployOpts): Promise<DeployHandle> {
    const cfg = this.cfgFrom(target);
    const kit = await this.kit(cfg.installationId);
    const [owner, name] = cfg.repoFullName.split('/');
    if (!owner || !name) throw new Error(`bad repoFullName ${cfg.repoFullName}`);

    const mode = cfg.triggerMode ?? 'dispatch';
    if (mode === 'observe') {
      const findTimeoutMs = cfg.observeFindTimeoutMs ?? 60_000;
      const runId = await this.findRecentRunForBranch(
        kit,
        owner,
        name,
        cfg.workflowFilename,
        opts.branch,
        findTimeoutMs,
      );
      return {
        externalRunId: String(runId),
        targetId: target.id,
        correlationId: opts.correlationId,
      };
    }

    const inputs = renderTemplate(cfg.inputsTemplate, {
      ref: { branch: opts.branch, sha: opts.ref },
      correlationId: opts.correlationId,
    });
    inputs['mergecrew_correlation_id'] = opts.correlationId;

    await kit.actions.createWorkflowDispatch({
      owner,
      repo: name,
      workflow_id: cfg.workflowFilename,
      ref: opts.branch,
      inputs,
    });

    // Find the run that matches our correlation id by polling recent runs.
    const runId = await this.findRunByCorrelation(kit, owner, name, cfg.workflowFilename, opts.branch, opts.correlationId);
    return {
      externalRunId: String(runId),
      targetId: target.id,
      correlationId: opts.correlationId,
    };
  }

  async getStatus(handle: DeployHandle): Promise<DeployStatus> {
    return this.statusByRunId(handle);
  }

  async awaitCompletion(
    handle: DeployHandle,
    timeoutMs: number,
    abort: AbortSignal,
  ): Promise<DeployResult> {
    const deadline = Date.now() + timeoutMs;
    let delay = 5_000;
    while (!abort.aborted && Date.now() < deadline) {
      const s = await this.statusByRunId(handle);
      if (s.kind === 'success' || s.kind === 'failed' || s.kind === 'cancelled') {
        const url = (s as any).url;
        return { status: s, url };
      }
      await sleep(Math.min(delay, deadline - Date.now()));
      delay = Math.min(delay * 1.4, 20_000);
    }
    return { status: { kind: 'failed', reason: 'timeout', finishedAt: new Date().toISOString() } };
  }

  async resolveUrlForRef(target: DeployTargetRef, ref: string): Promise<string | null> {
    const cfg = this.cfgFrom(target);
    if (cfg.urlResolution === 'fixed') return cfg.urlFixed ?? null;
    if (cfg.urlResolution === 'pattern' && cfg.urlPattern) {
      return cfg.urlPattern.replace(/\$\{branch\}/g, ref).replace(/\$\{sha\}/g, ref);
    }
    return null;
  }

  async fetchLogs(handle: DeployHandle, opts: { sinceMs?: number; tailLines?: number }): Promise<LogChunk[]> {
    // GitHub returns a zip of logs; we don't unzip in V1. Instead we stitch a
    // human-readable summary by listing the run's jobs and their conclusions.
    const meta = await this.runMeta(handle);
    if (!meta) return [];
    const out: LogChunk[] = meta.jobs.map((j) => ({
      ts: j.completed_at ?? j.started_at ?? new Date().toISOString(),
      line: `[${j.conclusion ?? j.status}] ${j.name}`,
      step: j.name,
    }));
    return opts.tailLines ? out.slice(-opts.tailLines) : out;
  }

  async rollbackProduction(target: DeployTargetRef, toRef: string): Promise<DeployHandle> {
    return this.triggerDeploy(target, {
      ref: toRef,
      branch: this.cfgFrom(target).repoFullName.split('/')[1] ?? 'main',
      correlationId: `rollback-${toRef}-${Date.now()}`,
    });
  }

  // ─── helpers ────────────────────────────────────────────────────────────

  /**
   * Observe mode: wait for a push/pull_request-triggered run on the
   * given branch + workflow to appear. The agent has just pushed, so
   * the run should materialize within a handful of seconds; we poll
   * until it does or the deadline expires.
   */
  private async findRecentRunForBranch(
    kit: Octokit,
    owner: string,
    name: string,
    workflowFilename: string,
    branch: string,
    timeoutMs: number,
  ): Promise<number> {
    const deadline = Date.now() + timeoutMs;
    let delay = 2_000;
    while (Date.now() < deadline) {
      const r = await kit.actions.listWorkflowRuns({
        owner,
        repo: name,
        workflow_id: workflowFilename,
        branch,
        per_page: 5,
      });
      // Match any run kicked off within the timeout window so we don't
      // pick up yesterday's stale success.
      const fresh = r.data.workflow_runs.find(
        (run) =>
          run.head_branch === branch &&
          Date.now() - new Date(run.created_at).getTime() < timeoutMs * 2,
      );
      if (fresh) return fresh.id;
      await sleep(Math.min(delay, deadline - Date.now()));
      delay = Math.min(delay * 1.5, 8_000);
    }
    throw new Error(
      `observe: no workflow run for ${workflowFilename} on branch ${branch} within ${timeoutMs}ms (operator's CI may not be configured to fire on this branch)`,
    );
  }

  private async findRunByCorrelation(
    kit: Octokit,
    owner: string,
    name: string,
    workflowFilename: string,
    branch: string,
    correlationId: string,
    attempts = 10,
  ): Promise<number> {
    for (let i = 0; i < attempts; i++) {
      const r = await kit.actions.listWorkflowRuns({
        owner,
        repo: name,
        workflow_id: workflowFilename,
        branch,
        event: 'workflow_dispatch',
        per_page: 20,
      });
      // Heuristic: match the most recent run whose head_sha + branch align,
      // started within the last 90s. The user's workflow can also surface the
      // correlation id as a job name to make matching exact (recommended).
      const recent = r.data.workflow_runs.filter(
        (run) => Date.now() - new Date(run.created_at).getTime() < 90_000 && run.head_branch === branch,
      );
      for (const run of recent) {
        const jobs = await kit.actions.listJobsForWorkflowRun({ owner, repo: name, run_id: run.id });
        if (jobs.data.jobs.some((j) => (j.name ?? '').includes(correlationId))) return run.id;
      }
      if (recent[0]) return recent[0].id; // fall back to the most recent dispatch
      await sleep(3_000);
    }
    throw new Error('could not locate workflow run for correlation id');
  }

  private async statusByRunId(handle: DeployHandle): Promise<DeployStatus> {
    const meta = await this.runMeta(handle);
    if (!meta) return { kind: 'queued' };
    if (meta.status !== 'completed') {
      return { kind: 'in_progress', latestStep: meta.jobs[meta.jobs.length - 1]?.name };
    }
    const conclusion = meta.conclusion;
    const finishedAt = meta.finishedAt ?? new Date().toISOString();
    if (conclusion === 'success') {
      return { kind: 'success', url: meta.deployUrl ?? '', finishedAt };
    }
    if (conclusion === 'cancelled' || conclusion === 'skipped') {
      return { kind: 'cancelled' };
    }
    return { kind: 'failed', reason: conclusion ?? 'unknown', finishedAt };
  }

  private async runMeta(handle: DeployHandle): Promise<{
    status: string;
    conclusion: string | null;
    finishedAt?: string;
    deployUrl?: string;
    jobs: { name: string; status: string; conclusion: string | null; started_at: string | null; completed_at: string | null }[];
  } | null> {
    // We don't have repoFullName on the handle alone — encode it via correlationId is not enough.
    // The runner is expected to call getStatus() with the same target handle context, but our
    // handle's externalRunId is unique enough to address the run if the caller also provides
    // target via getStatus. We return null when we lack the route.
    const route = handleRoutes.get(handle.externalRunId);
    if (!route) return null;
    const kit = await route.kit;
    const [owner, name] = route.repoFullName.split('/');
    const r = await kit.actions.getWorkflowRun({ owner: owner!, repo: name!, run_id: Number(handle.externalRunId) });
    const jobs = await kit.actions.listJobsForWorkflowRun({ owner: owner!, repo: name!, run_id: Number(handle.externalRunId) });
    return {
      status: r.data.status ?? 'queued',
      conclusion: r.data.conclusion,
      finishedAt: r.data.updated_at,
      jobs: jobs.data.jobs.map((j) => ({
        name: j.name,
        status: j.status,
        conclusion: j.conclusion,
        started_at: j.started_at,
        completed_at: j.completed_at,
      })),
    };
  }

  /** Called by the API/runner before kicking off polling so getStatus knows where the run lives. */
  static rememberRoute(externalRunId: string, repoFullName: string, kit: Promise<Octokit>): void {
    handleRoutes.set(externalRunId, { repoFullName, kit });
  }
}

const handleRoutes = new Map<string, { repoFullName: string; kit: Promise<Octokit> }>();

function renderTemplate(tpl: Record<string, string>, vars: any): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(tpl)) {
    out[k] = v.replace(/\$\{([^}]+)\}/g, (_, expr) => {
      const parts = expr.trim().split('.');
      let cur: any = vars;
      for (const p of parts) cur = cur?.[p];
      return cur == null ? '' : String(cur);
    });
  }
  return out;
}

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, Math.max(0, ms)));
}
