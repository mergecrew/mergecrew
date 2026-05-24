import { Body, Controller, Delete, Get, Param, Post, UseGuards } from '@nestjs/common';
import { IsString, MaxLength, MinLength } from 'class-validator';
import { RequireRole, RoleGuard } from '../../common/role.guard.js';
import { RunnerAgentService } from './runner-agent.service.js';

class IssueAgentDto {
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  name!: string;
}

/**
 * Admin-only endpoints for managing runner-agent enrollments
 * (V2.af / #765). Plaintext token is returned exactly once on POST.
 */
@Controller('v1/orgs/:slug/runner-agents')
@UseGuards(RoleGuard)
export class RunnerAgentController {
  constructor(private readonly agents: RunnerAgentService) {}

  @Post()
  @RequireRole('admin')
  async issue(@Body() body: IssueAgentDto) {
    return this.agents.issue({ name: body.name });
  }

  @Get()
  @RequireRole('admin')
  async list() {
    return { items: await this.agents.list() };
  }

  @Delete(':id')
  @RequireRole('admin')
  async revoke(@Param('id') id: string) {
    await this.agents.revoke(id);
    return { ok: true };
  }
}
