import {
  Body,
  Controller,
  Headers,
  HttpCode,
  Param,
  Post,
  Query,
  UnauthorizedException,
} from '@nestjs/common';
import { IsIn, IsObject, IsOptional, IsString, MaxLength } from 'class-validator';
import {
  RunnerAgentService,
  type AgentStepOutcome,
} from './runner-agent.service.js';

class HelloDto {
  @IsOptional()
  @IsString()
  @MaxLength(64)
  agentVersion?: string;
}

class HeartbeatDto {
  @IsString()
  @MaxLength(64)
  stepId!: string;
}

class EventDto {
  @IsString()
  @MaxLength(80)
  type!: string;

  @IsOptional()
  @IsObject()
  payload?: Record<string, unknown>;
}

class OutcomeDto {
  @IsString()
  @IsIn(['completed', 'failed', 'cancelled'])
  kind!: 'completed' | 'failed' | 'cancelled';

  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;

  @IsOptional()
  output?: unknown;
}

const DEFAULT_POLL_TIMEOUT_SEC = 30;
const MAX_POLL_TIMEOUT_SEC = 30;

/**
 * Agent-side public endpoints (V2.af / #765, #766). Not org-scoped via
 * URL; authenticated via the `Authorization: Bearer mca_…` header.
 * Falls through the tenant middleware (which only matches `/v1/orgs/*`)
 * and resolves to an org via the agent token.
 *
 * #765 shipped `/hello`. #766 adds the long-poll job pull plus
 * heartbeat/events/outcome. The agent-side executor is a stub for v1
 * (returns `byo_executor_not_implemented`); real execution lands in
 * the follow-up #782.
 */
@Controller('v1/runner-agent')
export class RunnerAgentPublicController {
  constructor(private readonly agents: RunnerAgentService) {}

  private async resolveBearer(authHeader: string | undefined, agentVersion?: string) {
    const bearer = authHeader?.startsWith('Bearer ')
      ? authHeader.slice('Bearer '.length).trim()
      : undefined;
    if (!bearer) {
      throw new UnauthorizedException({ code: 'UNAUTHORIZED' });
    }
    return this.agents.resolveAgent(bearer, agentVersion);
  }

  @Post('hello')
  async hello(
    @Headers('authorization') authHeader: string | undefined,
    @Body() body: HelloDto,
  ) {
    const identity = await this.resolveBearer(authHeader, body?.agentVersion);
    return {
      ok: true,
      orgId: identity.organizationId,
      orgSlug: identity.organizationSlug,
      agentId: identity.agentId,
      agentName: identity.agentName,
    };
  }

  /**
   * Long-poll for the next job in the agent's org queue. Holds the
   * request up to `timeout` seconds (capped at 30) and returns either:
   *   - `{ kind: 'idle' }` if the queue stayed empty.
   *   - `{ kind: 'job', ...payload }` on hit. The agent acks by
   *     subsequently posting heartbeats and an outcome for the same
   *     `stepId`.
   *
   * The long-poll budget is intentionally short so an upstream proxy
   * with a 60s idle timeout doesn't kill the connection.
   */
  @Post('poll')
  @HttpCode(200)
  async poll(
    @Headers('authorization') authHeader: string | undefined,
    @Query('timeout') timeoutQuery: string | undefined,
  ) {
    const identity = await this.resolveBearer(authHeader);
    const timeoutSec = Math.min(
      MAX_POLL_TIMEOUT_SEC,
      Math.max(1, Number(timeoutQuery ?? DEFAULT_POLL_TIMEOUT_SEC)),
    );
    const job = await this.agents.pollNextJob(identity.organizationId, timeoutSec);
    if (!job) return { kind: 'idle' as const };
    return { kind: 'job' as const, ...job };
  }

  @Post('heartbeat')
  @HttpCode(200)
  async heartbeat(
    @Headers('authorization') authHeader: string | undefined,
    @Body() body: HeartbeatDto,
  ) {
    const identity = await this.resolveBearer(authHeader);
    await this.agents.heartbeatStep(identity.organizationId, body.stepId);
    return { ok: true };
  }

  @Post('steps/:stepId/events')
  @HttpCode(200)
  async events(
    @Headers('authorization') authHeader: string | undefined,
    @Param('stepId') stepId: string,
    @Body() body: EventDto,
  ) {
    const identity = await this.resolveBearer(authHeader);
    await this.agents.recordStepEvent(identity.organizationId, stepId, {
      type: body.type,
      payload: body.payload,
    });
    return { ok: true };
  }

  @Post('steps/:stepId/outcome')
  @HttpCode(200)
  async outcome(
    @Headers('authorization') authHeader: string | undefined,
    @Param('stepId') stepId: string,
    @Body() body: OutcomeDto,
  ) {
    const identity = await this.resolveBearer(authHeader);
    const outcome: AgentStepOutcome =
      body.kind === 'completed'
        ? { kind: 'completed', output: body.output }
        : body.kind === 'cancelled'
        ? { kind: 'cancelled' }
        : { kind: 'failed', reason: body.reason ?? 'unspecified' };
    await this.agents.recordStepOutcome({
      organizationId: identity.organizationId,
      stepId,
      outcome,
    });
    return { ok: true };
  }
}
