import { Body, Controller, Headers, Post, UnauthorizedException } from '@nestjs/common';
import { IsOptional, IsString, MaxLength } from 'class-validator';
import { RunnerAgentService } from './runner-agent.service.js';

class HelloDto {
  @IsOptional()
  @IsString()
  @MaxLength(64)
  agentVersion?: string;
}

/**
 * Agent-side public endpoints (V2.af / #765). Not org-scoped via URL;
 * authenticated via the `Authorization: Bearer mca_…` header, which
 * resolves to a `RunnerAgent` row and therefore to its org.
 *
 * The tenant middleware (`apps/api/src/common/tenant.middleware.ts`)
 * only fires for `/v1/orgs/*` paths, so this controller falls through
 * to its own auth gate via `RunnerAgentService.resolveAgent`.
 *
 * #765 ships only `/hello` — the long-poll job pull, heartbeat, events,
 * and outcome endpoints arrive in #766.
 */
@Controller('v1/runner-agent')
export class RunnerAgentPublicController {
  constructor(private readonly agents: RunnerAgentService) {}

  @Post('hello')
  async hello(
    @Headers('authorization') authHeader: string | undefined,
    @Body() body: HelloDto,
  ) {
    const bearer = authHeader?.startsWith('Bearer ')
      ? authHeader.slice('Bearer '.length).trim()
      : undefined;
    if (!bearer) {
      throw new UnauthorizedException({ code: 'UNAUTHORIZED' });
    }
    const identity = await this.agents.resolveAgent(bearer, body?.agentVersion);
    return {
      ok: true,
      orgId: identity.organizationId,
      orgSlug: identity.organizationSlug,
      agentId: identity.agentId,
      agentName: identity.agentName,
    };
  }
}
