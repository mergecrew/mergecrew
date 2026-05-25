import {
  Body,
  Controller,
  Headers,
  HttpCode,
  Param,
  Post,
  UnauthorizedException,
} from '@nestjs/common';
import { IsBoolean, IsObject, IsOptional, IsString, MaxLength } from 'class-validator';
import { requireInternalBearer } from '../../common/internal-auth.js';
import { RunnerAgentService } from './runner-agent.service.js';
import { SandboxOpsService, type ResultEnvelope } from './sandbox-ops.service.js';

class PollOpsDto {
  @IsString()
  @MaxLength(64)
  stepId!: string;

  @IsOptional()
  timeoutSec?: number;
}

class PostResultDto {
  @IsBoolean()
  ok!: boolean;

  @IsOptional()
  result?: unknown;

  @IsOptional()
  @IsObject()
  error?: { message: string; kind?: string };
}

/**
 * Mediator endpoints between the supervisor (which calls
 * `HttpSandboxDriver`) and the BYO agent (which long-polls and
 * executes sandbox ops locally). See ADR-0009 step 2.
 *
 * Three paths, two auth modes:
 *
 *   POST  /v1/runner-agent/sandbox-ops/:stepId/:op
 *      → supervisor-initiated dispatch. Authenticated by the
 *        deployment-internal shared secret (MERGECREW_INTERNAL_TOKEN).
 *        Enqueues the op + blocks on the result.
 *
 *   POST  /v1/runner-agent/sandbox-ops-poll
 *      → agent-initiated. Body { stepId, timeoutSec }. Bearer-token
 *        authenticated (resolveAgent). BRPOPs the next op for the
 *        step; returns idle on timeout.
 *
 *   POST  /v1/runner-agent/sandbox-ops/:stepId/:opId/result
 *      → agent-initiated. Body { ok, result?, error? }. Posts the
 *        result, unblocking the supervisor's BRPOP.
 *
 * The :op + :opId/result routes look similar; NestJS routes by path
 * segment count, so they don't conflict.
 */
@Controller('v1/runner-agent')
export class SandboxOpsController {
  constructor(
    private readonly agents: RunnerAgentService,
    private readonly ops: SandboxOpsService,
  ) {}

  private async resolveAgentBearer(authHeader: string | undefined) {
    const bearer = authHeader?.startsWith('Bearer ')
      ? authHeader.slice('Bearer '.length).trim()
      : undefined;
    if (!bearer) throw new UnauthorizedException({ code: 'UNAUTHORIZED' });
    return this.agents.resolveAgent(bearer);
  }

  @Post('sandbox-ops/:stepId/:op')
  @HttpCode(200)
  async dispatch(
    @Headers('authorization') authHeader: string | undefined,
    @Param('stepId') stepId: string,
    @Param('op') op: string,
    @Body() body: unknown,
  ): Promise<ResultEnvelope> {
    requireInternalBearer(authHeader);
    return this.ops.dispatch(stepId, op, body);
  }

  @Post('sandbox-ops-poll')
  @HttpCode(200)
  async poll(
    @Headers('authorization') authHeader: string | undefined,
    @Body() body: PollOpsDto,
  ) {
    const identity = await this.resolveAgentBearer(authHeader);
    await this.ops.assertStepBelongsToOrg(body.stepId, identity.organizationId);
    const opEnv = await this.ops.pollNextOp(body.stepId, body.timeoutSec ?? 30);
    if (!opEnv) return { kind: 'idle' as const };
    return { kind: 'op' as const, ...opEnv };
  }

  @Post('sandbox-ops/:stepId/:opId/result')
  @HttpCode(200)
  async postResult(
    @Headers('authorization') authHeader: string | undefined,
    @Param('stepId') stepId: string,
    @Param('opId') opId: string,
    @Body() body: PostResultDto,
  ) {
    const identity = await this.resolveAgentBearer(authHeader);
    await this.ops.assertStepBelongsToOrg(stepId, identity.organizationId);
    await this.ops.postResult(stepId, opId, {
      ok: body.ok,
      result: body.result,
      error: body.error,
    });
    return { ok: true };
  }
}
