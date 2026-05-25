import { randomUUID } from 'node:crypto';
import { Injectable, NotFoundException, RequestTimeoutException } from '@nestjs/common';
import { PrismaService } from '../../common/prisma.service.js';
import { QueueService } from '../../common/queue.service.js';

/**
 * Per-step sandbox-op mediator (V2.ag / ADR-0009 step 2).
 *
 * The supervisor's HttpSandboxDriver (`packages/sandbox-driver`)
 * marshals every SandboxDriver method into a POST. This service
 * holds the supervisor's request open while the agent — long-polling
 * on the other end — picks the op off `runner-agent:sandbox-ops:<stepId>`,
 * executes it locally, and POSTs the result back to
 * `runner-agent:sandbox-results:<stepId>:<opId>`.
 *
 * Raw Redis lists — same rationale as the agent queue in #766
 * (long-poll BRPOP, no BullMQ active/completed bookkeeping).
 */

export function opsKey(stepId: string): string {
  return `runner-agent:sandbox-ops:${stepId}`;
}

export function resultKey(stepId: string, opId: string): string {
  return `runner-agent:sandbox-results:${stepId}:${opId}`;
}

/**
 * Hard server-side ceiling on how long a single op can take. Beyond
 * this we abandon the BRPOP and return a 504 to the supervisor so it
 * doesn't hang an HTTP connection forever. Step-level cancellation
 * still flows through the existing agent cancel path.
 */
const MAX_OP_WAIT_SEC = 15 * 60;

export interface OpEnvelope {
  opId: string;
  op: string;
  args: unknown;
}

export interface ResultEnvelope {
  ok: boolean;
  result?: unknown;
  error?: { message: string; kind?: string };
}

@Injectable()
export class SandboxOpsService {
  constructor(
    private readonly queues: QueueService,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * Supervisor-initiated dispatch. Enqueues the op, blocks on its
   * result list, returns whatever the agent posted back.
   *
   * Returning the agent's result envelope verbatim (vs. unwrapping
   * `result`/`error` here) keeps the HttpSandboxDriver code as the
   * single decoder of agent responses — symmetric error handling.
   */
  async dispatch(stepId: string, op: string, args: unknown): Promise<ResultEnvelope> {
    const opId = randomUUID();
    const redis = this.queues.connectionHandle();
    const envelope: OpEnvelope = { opId, op, args };

    // LPUSH onto the ops queue (RPUSH would also work; LPUSH+BRPOP is
    // the conventional FIFO pairing for ioredis).
    await redis.lpush(opsKey(stepId), JSON.stringify(envelope));

    // BRPOP the per-(step, op) result list. Timeout is clamped to a
    // sane upper bound — long enough for a 10-minute build, short
    // enough that a stuck request can't hold a connection forever.
    const popped = await redis.brpop(resultKey(stepId, opId), MAX_OP_WAIT_SEC);
    if (!popped) {
      throw new RequestTimeoutException({
        code: 'SANDBOX_OP_TIMEOUT',
        message: `agent did not return a result for op ${op} on step ${stepId} within ${MAX_OP_WAIT_SEC}s`,
      });
    }
    const [, raw] = popped;
    try {
      return JSON.parse(raw) as ResultEnvelope;
    } catch {
      throw new Error(`malformed result envelope for op ${op} on step ${stepId}`);
    }
  }

  /**
   * Agent-initiated poll. Blocks up to `timeoutSec` (capped at 30s
   * for the same proxy-idle reason as the job-poll endpoint).
   */
  async pollNextOp(stepId: string, timeoutSec: number): Promise<OpEnvelope | null> {
    const redis = this.queues.connectionHandle();
    const popped = await redis.brpop(opsKey(stepId), Math.min(30, Math.max(1, timeoutSec)));
    if (!popped) return null;
    const [, raw] = popped;
    try {
      return JSON.parse(raw) as OpEnvelope;
    } catch {
      return null;
    }
  }

  /**
   * Agent-initiated result post. LPUSHes onto the (step, op)-keyed
   * result list, unblocking the supervisor's BRPOP in `dispatch`.
   *
   * The result list is single-use — once popped it's gone. Set a
   * short TTL so a supervisor crash + agent posting late doesn't
   * leak keys indefinitely.
   */
  async postResult(stepId: string, opId: string, envelope: ResultEnvelope): Promise<void> {
    const redis = this.queues.connectionHandle();
    const key = resultKey(stepId, opId);
    await redis.lpush(key, JSON.stringify(envelope));
    // 1h TTL — generous compared to the dispatcher's 15-min ceiling
    // but defends against stranded keys in failure modes the BRPOP
    // doesn't naturally clean up.
    await redis.expire(key, 60 * 60);
  }

  /**
   * Validate that a stepId belongs to the agent's org. Used by both
   * agent-side endpoints (poll + postResult) so a compromised agent
   * token can't snoop another org's sandbox ops.
   */
  async assertStepBelongsToOrg(stepId: string, organizationId: string): Promise<void> {
    const step = await this.prisma.withTenant(organizationId, (tx) =>
      tx.agentStep.findUnique({
        where: { id: stepId },
        select: { organizationId: true },
      }),
    );
    if (!step || step.organizationId !== organizationId) {
      throw new NotFoundException();
    }
  }
}
