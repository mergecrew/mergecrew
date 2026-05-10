import type {
  DeployHandle,
  DeployOpts,
  DeployProvider,
  DeployResult,
  DeployStatus,
  DeployTargetRef,
  LogChunk,
} from './types.js';

interface RailwayConfig {
  /** Personal token or project access token. Project tokens are recommended for CI. */
  token: string;
  /**
   * Optional override for the GraphQL endpoint. Defaults to Railway's
   * production backboard. Self-hosted Railway isn't a thing today, but
   * the option exists so a future stub or proxy can sit between us and
   * the real API in tests.
   */
  endpoint?: string;
}

interface RailwayTargetConfig {
  /** Railway project id (UUID). */
  projectId: string;
  /** Environment id within the project (UUID), e.g. production. */
  environmentId: string;
  /** Service id within the environment (UUID). One Railway project can host many services. */
  serviceId: string;
}

/**
 * Railway deploy provider (#200).
 *
 * Railway's API is GraphQL at backboard.railway.app/graphql/v2. We
 * model deploys via the project-level deployment endpoints:
 *
 *  - **Trigger:** \`deploymentTriggerCreate\` mutation pointing at the
 *    project's connected git repo + a branch / commit. Railway then
 *    builds via Nixpacks or the project's Dockerfile.
 *  - **Status / URL / logs:** \`deployment\` query by deployment id.
 *  - **Rollback:** \`deploymentRedeploy\` against the older deployment id
 *    of the desired commit.
 *
 * State mapping (Railway's deployment status enum):
 *   QUEUED / WAITING / INITIALIZING / SLEEPING → queued
 *   BUILDING / DEPLOYING                       → in_progress
 *   SUCCESS                                    → success
 *   FAILED / CRASHED                           → failed
 *   REMOVED / SKIPPED                          → cancelled
 */
export class RailwayProvider implements DeployProvider {
  readonly id = 'railway' as const;
  private token: string;
  private endpoint: string;

  constructor(cfg: RailwayConfig) {
    this.token = cfg.token;
    this.endpoint = cfg.endpoint ?? 'https://backboard.railway.app/graphql/v2';
  }

  private cfgFrom(target: DeployTargetRef): RailwayTargetConfig {
    return target.config as unknown as RailwayTargetConfig;
  }

  private async gql<T = any>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    const r = await fetch(this.endpoint, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ query, variables }),
    });
    if (!r.ok) throw new Error(`railway ${r.status}: ${await r.text()}`);
    const json = (await r.json()) as { data?: T; errors?: Array<{ message: string }> };
    if (json.errors && json.errors.length > 0) {
      throw new Error(`railway: ${json.errors.map((e) => e.message).join('; ')}`);
    }
    if (!json.data) throw new Error('railway: empty response');
    return json.data as T;
  }

  async triggerDeploy(target: DeployTargetRef, opts: DeployOpts): Promise<DeployHandle> {
    const cfg = this.cfgFrom(target);
    const data = await this.gql<{ deploymentTriggerCreate: { id: string } }>(
      `mutation TriggerDeploy($input: DeploymentTriggerCreateInput!) {
        deploymentTriggerCreate(input: $input) { id }
      }`,
      {
        input: {
          projectId: cfg.projectId,
          environmentId: cfg.environmentId,
          serviceId: cfg.serviceId,
          branch: opts.branch,
          commitSha: opts.ref || undefined,
        },
      },
    );
    return {
      externalRunId: data.deploymentTriggerCreate.id,
      targetId: target.id,
      correlationId: opts.correlationId,
    };
  }

  async getStatus(handle: DeployHandle): Promise<DeployStatus> {
    const data = await this.gql<{
      deployment: {
        status: string;
        staticUrl?: string;
        url?: string;
        finishedAt?: string;
        canRedeploy?: boolean;
        error?: string;
      } | null;
    }>(
      `query Deployment($id: String!) {
        deployment(id: $id) {
          status
          staticUrl
          url
          finishedAt
          canRedeploy
        }
      }`,
      { id: handle.externalRunId },
    );
    const d = data.deployment;
    if (!d) return { kind: 'queued' };
    switch (d.status) {
      case 'QUEUED':
      case 'WAITING':
      case 'INITIALIZING':
      case 'SLEEPING':
        return { kind: 'queued' };
      case 'BUILDING':
      case 'DEPLOYING':
        return { kind: 'in_progress', latestStep: d.status };
      case 'SUCCESS':
        return {
          kind: 'success',
          url: d.staticUrl ?? d.url ?? '',
          finishedAt: d.finishedAt ?? new Date().toISOString(),
        };
      case 'FAILED':
      case 'CRASHED':
        return {
          kind: 'failed',
          reason: d.status,
          finishedAt: d.finishedAt ?? new Date().toISOString(),
        };
      case 'REMOVED':
      case 'SKIPPED':
        return { kind: 'cancelled' };
      default:
        return { kind: 'in_progress', latestStep: d.status };
    }
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

  async resolveUrlForRef(target: DeployTargetRef, ref: string): Promise<string | null> {
    const cfg = this.cfgFrom(target);
    const data = await this.gql<{
      deployments: { edges: Array<{ node: { meta?: any; staticUrl?: string; url?: string; status?: string } }> };
    }>(
      `query Deployments($projectId: String!, $environmentId: String!, $serviceId: String!) {
        deployments(
          first: 50,
          input: {
            projectId: $projectId,
            environmentId: $environmentId,
            serviceId: $serviceId
          }
        ) {
          edges { node { meta status staticUrl url } }
        }
      }`,
      {
        projectId: cfg.projectId,
        environmentId: cfg.environmentId,
        serviceId: cfg.serviceId,
      },
    );
    const match = data.deployments.edges.find(
      (e) => e.node.meta?.commitSha === ref || e.node.meta?.commitHash === ref,
    );
    if (!match) return null;
    return match.node.staticUrl ?? match.node.url ?? null;
  }

  async fetchLogs(handle: DeployHandle, opts: { tailLines?: number }): Promise<LogChunk[]> {
    const data = await this.gql<{
      deploymentLogs: Array<{ timestamp: string; message: string; severity?: string }>;
    }>(
      `query Logs($deploymentId: String!, $limit: Int) {
        deploymentLogs(deploymentId: $deploymentId, limit: $limit) {
          timestamp message severity
        }
      }`,
      { deploymentId: handle.externalRunId, limit: opts.tailLines ?? 200 },
    );
    return (data.deploymentLogs ?? []).map((l) => ({ ts: l.timestamp, line: l.message }));
  }

  async rollbackProduction(target: DeployTargetRef, toRef: string): Promise<DeployHandle> {
    const cfg = this.cfgFrom(target);
    // Find a previous deployment whose commit matches toRef, then redeploy it.
    const list = await this.gql<{
      deployments: { edges: Array<{ node: { id: string; meta?: any } }> };
    }>(
      `query Deployments($projectId: String!, $environmentId: String!, $serviceId: String!) {
        deployments(
          first: 100,
          input: {
            projectId: $projectId,
            environmentId: $environmentId,
            serviceId: $serviceId
          }
        ) {
          edges { node { id meta } }
        }
      }`,
      {
        projectId: cfg.projectId,
        environmentId: cfg.environmentId,
        serviceId: cfg.serviceId,
      },
    );
    const match = list.deployments.edges.find(
      (e) => e.node.meta?.commitSha === toRef || e.node.meta?.commitHash === toRef,
    );
    if (!match) throw new Error(`no deployment with sha ${toRef}`);
    const r = await this.gql<{ deploymentRedeploy: { id: string } }>(
      `mutation Redeploy($id: String!) {
        deploymentRedeploy(id: $id) { id }
      }`,
      { id: match.node.id },
    );
    return {
      externalRunId: r.deploymentRedeploy.id,
      targetId: target.id,
      correlationId: `rollback-${match.node.id}`,
    };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, Math.max(0, ms)));
}
