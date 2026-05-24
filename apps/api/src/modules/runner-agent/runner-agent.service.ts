import { createHash, randomBytes } from 'node:crypto';
import { Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { PrismaService } from '../../common/prisma.service.js';
import { QueueService } from '../../common/queue.service.js';
import { TenantContextService } from '../../common/tenant-context.service.js';

/**
 * Per-org agent queue key in Redis (V2.af / #766, ADR-0005). Raw list,
 * not a BullMQ queue — long-poll BRPOP is the consumer pattern and we
 * intentionally skip BullMQ's active/completed bookkeeping on this
 * path because the agent has its own heartbeat + outcome reply.
 *
 * KEEP IN SYNC WITH `apps/orchestrator/src/orchestrator.ts`.
 */
export function agentQueueKey(organizationId: string): string {
  return `runner-agent:queue:${organizationId}`;
}

/**
 * Runner-agent enrollment (V2.af / #765 / ADR-0004).
 *
 * Token shape:   mca_<orgSlug>_<26 base32 chars>
 * Storage:       only the sha256(token) hex is persisted.
 * Lifecycle:     created via the org-scoped admin endpoint; one-shot reveal;
 *                revoked via the admin endpoint (sets revokedAt).
 * Auth:          the runner-agent's public endpoints (e.g. /hello) match the
 *                Bearer header by hashing and looking up by tokenHash.
 */
export const RUNNER_AGENT_TOKEN_PREFIX = 'mca_';
export const RUNNER_AGENT_TOKEN_SECRET_LENGTH = 26;
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export interface IssuedRunnerAgent {
  id: string;
  name: string;
  prefix: string;
  createdAt: Date;
  /** Plaintext token. Returned ONCE on creation; never again. */
  token: string;
}

export interface RunnerAgentSummary {
  id: string;
  name: string;
  prefix: string;
  createdAt: Date;
  lastSeenAt: Date | null;
  revokedAt: Date | null;
  agentVersion: string | null;
}

export interface AgentIdentity {
  agentId: string;
  organizationId: string;
  organizationSlug: string;
  agentName: string;
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Generates a 26-char base32 secret (~130 bits of entropy). Uses
 * `randomBytes` for cryptographic randomness; the loop just maps each
 * byte mod 32 into the base32 alphabet. Bias from `% 32` on a uniform
 * byte is negligible for this length.
 */
function generateSecret(): string {
  const out: string[] = [];
  const buf = randomBytes(RUNNER_AGENT_TOKEN_SECRET_LENGTH);
  for (let i = 0; i < RUNNER_AGENT_TOKEN_SECRET_LENGTH; i++) {
    out.push(BASE32_ALPHABET[buf[i]! & 0x1f]!);
  }
  return out.join('');
}

/**
 * Job payload that lands on the per-org agent queue. Matches the
 * orchestrator's `enqueueRunnerStep` shape — duplicated here so the API
 * doesn't pull the orchestrator package just for a type.
 */
export interface AgentJobPayload {
  organizationId: string;
  projectId: string;
  runId: string;
  workflowRunId: string;
  stepId: string;
  agentRef: string;
}

/** Outcome shapes the agent posts back. Mirrors `onStepReply` in orchestrator. */
export type AgentStepOutcome =
  | { kind: 'completed'; output?: unknown; toolCallsMade?: number; totalTokens?: number }
  | { kind: 'failed'; reason: string }
  | { kind: 'cancelled' };

@Injectable()
export class RunnerAgentService {
  constructor(
    private prisma: PrismaService,
    private queues: QueueService,
    private tenant: TenantContextService,
  ) {}

  /**
   * Issue a new agent + return the plaintext token exactly once. The
   * caller must be an org admin (guard enforced at the controller).
   * Caller-supplied `name` is a free-form display label (e.g. "homelab-1").
   */
  async issue(input: { name: string }): Promise<IssuedRunnerAgent> {
    const t = this.tenant.require();
    const secret = generateSecret();
    const token = `${RUNNER_AGENT_TOKEN_PREFIX}${t.organizationSlug}_${secret}`;
    const tokenHash = hashToken(token);
    // 14-char display prefix is enough to distinguish agents in the UI
    // without leaking enough to brute-force the rest. `mca_<slug>_<6>`
    // takes the first 6 base32 chars of the secret.
    const prefixLen = `${RUNNER_AGENT_TOKEN_PREFIX}${t.organizationSlug}_`.length + 6;
    const displayPrefix = token.slice(0, prefixLen);

    const row = await this.prisma.withTenant(t.organizationId, (tx) =>
      tx.runnerAgent.create({
        data: {
          organizationId: t.organizationId,
          name: input.name,
          tokenHash,
          prefix: displayPrefix,
          createdByUserId: t.userId,
        },
      }),
    );

    await this.prisma.withTenant(t.organizationId, (tx) =>
      tx.auditLogEntry.create({
        data: {
          organizationId: t.organizationId,
          actorUserId: t.userId,
          action: 'runnerAgent.created',
          target: { runnerAgentId: row.id },
          metadata: { name: row.name, prefix: row.prefix },
        },
      }),
    );

    return {
      id: row.id,
      name: row.name,
      prefix: row.prefix,
      createdAt: row.createdAt,
      token,
    };
  }

  async list(): Promise<RunnerAgentSummary[]> {
    const t = this.tenant.require();
    const rows = await this.prisma.withTenant(t.organizationId, (tx) =>
      tx.runnerAgent.findMany({
        where: { organizationId: t.organizationId },
        orderBy: [{ revokedAt: 'asc' }, { createdAt: 'desc' }],
      }),
    );
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      prefix: r.prefix,
      createdAt: r.createdAt,
      lastSeenAt: r.lastSeenAt,
      revokedAt: r.revokedAt,
      agentVersion: r.agentVersion,
    }));
  }

  async revoke(id: string): Promise<void> {
    const t = this.tenant.require();
    const found = await this.prisma.withTenant(t.organizationId, (tx) =>
      tx.runnerAgent.findFirst({ where: { id, organizationId: t.organizationId } }),
    );
    if (!found) throw new NotFoundException();
    if (found.revokedAt) return;

    await this.prisma.withTenant(t.organizationId, (tx) =>
      tx.runnerAgent.update({
        where: { id },
        data: { revokedAt: new Date() },
      }),
    );

    await this.prisma.withTenant(t.organizationId, (tx) =>
      tx.auditLogEntry.create({
        data: {
          organizationId: t.organizationId,
          actorUserId: t.userId,
          action: 'runnerAgent.revoked',
          target: { runnerAgentId: id },
          metadata: { name: found.name, prefix: found.prefix },
        },
      }),
    );
  }

  /**
   * Authenticate a bearer token from the runner-agent's outbound calls
   * (`/v1/runner-agent/*`). Returns the agent identity on hit + bumps
   * `lastSeenAt`. Throws 401 on any miss (unknown / revoked).
   *
   * Bypasses RLS via `withSystem` because the org isn't known until
   * after the lookup — every subsequent query in the caller is expected
   * to switch to `withTenant(agent.organizationId, …)`.
   */
  async resolveAgent(bearer: string, agentVersion?: string): Promise<AgentIdentity> {
    if (!bearer.startsWith(RUNNER_AGENT_TOKEN_PREFIX)) {
      throw new UnauthorizedException({ code: 'UNAUTHORIZED' });
    }
    const tokenHash = hashToken(bearer);
    const row = await this.prisma.withSystem((tx) =>
      tx.runnerAgent.findUnique({
        where: { tokenHash },
        include: { organization: { select: { slug: true } } },
      }),
    );
    if (!row || row.revokedAt) {
      throw new UnauthorizedException({ code: 'UNAUTHORIZED' });
    }

    // Fire-and-forget `lastSeenAt` (and optional version) bump. Failure
    // must not block the request — a transient write error would
    // poison every poll/hello otherwise.
    void this.prisma
      .withSystem((tx) =>
        tx.runnerAgent.update({
          where: { id: row.id },
          data: {
            lastSeenAt: new Date(),
            ...(agentVersion ? { agentVersion } : {}),
          },
        }),
      )
      .catch(() => {});

    return {
      agentId: row.id,
      organizationId: row.organizationId,
      organizationSlug: row.organization.slug,
      agentName: row.name,
    };
  }

  /**
   * Long-poll for the next agent job (V2.af / #766). Blocks up to
   * `timeoutSec` seconds on the per-org agent queue. Returns null on
   * timeout, or the parsed job payload on hit.
   *
   * Uses raw Redis BRPOP — see `agentQueueKey` for the rationale.
   */
  async pollNextJob(
    organizationId: string,
    timeoutSec: number,
  ): Promise<AgentJobPayload | null> {
    const redis = this.queues.connectionHandle();
    const key = agentQueueKey(organizationId);
    const result = await redis.brpop(key, timeoutSec);
    if (!result) return null;
    // ioredis returns [key, value]; defensive parsing below covers a
    // malformed payload (e.g. an orchestrator writing the wrong shape)
    // by surfacing as null rather than a 500 from JSON.parse.
    const [, raw] = result;
    try {
      const parsed = JSON.parse(raw) as AgentJobPayload;
      return parsed;
    } catch {
      return null;
    }
  }

  /**
   * Heartbeat an in-flight step the agent is processing (#766). Mirrors
   * the supervisor's heartbeat write at `apps/runner/src/step.ts`. The
   * orchestrator's heartbeat sweeper considers a step live so long as
   * `heartbeatAt` advances within its staleness threshold.
   *
   * Authorization: the agent's resolved identity must own the step's
   * org. Caller (controller) is expected to have already called
   * `resolveAgent` on the bearer.
   */
  async heartbeatStep(organizationId: string, stepId: string): Promise<void> {
    await this.prisma.withTenant(organizationId, async (tx) => {
      const found = await tx.agentStep.findUnique({
        where: { id: stepId },
        select: { organizationId: true },
      });
      if (!found || found.organizationId !== organizationId) {
        throw new NotFoundException();
      }
      await tx.agentStep.update({
        where: { id: stepId },
        data: { heartbeatAt: new Date() },
      });
    });
  }

  /**
   * Forward an event the agent observed during step execution into the
   * deployment's eventlog. v1 ships the protocol; events flow into the
   * timeline via the existing `agentStep`-scoped event types (e.g.
   * `AGENT_STEP_LOG`, `AGENT_STEP_STARTED`). v1.1 expands the schema
   * + adds richer agent-side telemetry.
   */
  async recordStepEvent(
    organizationId: string,
    stepId: string,
    event: { type: string; payload?: Record<string, unknown> },
  ): Promise<void> {
    // For v1 we don't yet wire a separate eventlog forwarder — the
    // outcome reply on `orchestrator.step-reply` carries the terminal
    // state. Intermediate events are stored as audit-log entries so an
    // operator can still see what the agent reported. v1.1 will route
    // them through the proper Eventlog with workflow_run + daily_run
    // context (which the agent doesn't currently send back).
    await this.prisma.withTenant(organizationId, async (tx) => {
      const found = await tx.agentStep.findUnique({
        where: { id: stepId },
        select: { organizationId: true },
      });
      if (!found || found.organizationId !== organizationId) {
        throw new NotFoundException();
      }
      await tx.auditLogEntry.create({
        data: {
          organizationId,
          action: `runnerAgent.event.${event.type}`,
          target: { agentStepId: stepId },
          metadata: (event.payload ?? {}) as any,
        },
      });
    });
  }

  /**
   * Record the terminal outcome and notify the orchestrator. The agent
   * is responsible for calling this exactly once per job; the
   * orchestrator advances the workflow off the resulting
   * `orchestrator.step-reply` job.
   */
  async recordStepOutcome(args: {
    organizationId: string;
    stepId: string;
    outcome: AgentStepOutcome;
  }): Promise<void> {
    const { organizationId, stepId, outcome } = args;
    const step = await this.prisma.withTenant(organizationId, (tx) =>
      tx.agentStep.findUnique({
        where: { id: stepId },
        select: { organizationId: true, workflowRunId: true },
      }),
    );
    if (!step || step.organizationId !== organizationId) {
      throw new NotFoundException();
    }
    const wf = await this.prisma.withTenant(organizationId, (tx) =>
      tx.workflowRun.findUnique({
        where: { id: step.workflowRunId },
        select: {
          dailyRunId: true,
          dailyRun: { select: { projectId: true } },
        },
      }),
    );
    if (!wf) throw new NotFoundException();

    // Mirror the supervisor's terminal step update + step-reply enqueue
    // shape so the orchestrator's onStepReply doesn't need a special
    // case for agent-sourced replies.
    const status =
      outcome.kind === 'completed' ? 'completed'
      : outcome.kind === 'cancelled' ? 'cancelled'
      : 'failed';
    await this.prisma.withTenant(organizationId, (tx) =>
      tx.agentStep.update({
        where: { id: stepId },
        data: {
          status,
          finishedAt: new Date(),
          heartbeatAt: null,
          ...(outcome.kind === 'failed' ? { failureReason: outcome.reason } : {}),
        },
      }),
    );
    await this.queues.get('orchestrator.step-reply').add(
      'reply',
      {
        organizationId,
        projectId: wf.dailyRun.projectId,
        runId: wf.dailyRunId,
        workflowRunId: step.workflowRunId,
        stepId,
        outcome,
      },
      { removeOnComplete: 1000, removeOnFail: 1000 },
    );
  }
}
