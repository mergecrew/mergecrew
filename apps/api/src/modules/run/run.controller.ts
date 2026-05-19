import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { RunService } from './run.service.js';
import { RequireRole, RoleGuard } from '../../common/role.guard.js';

@Controller('v1/orgs/:slug/projects/:projectSlug/runs')
@UseGuards(RoleGuard)
export class RunController {
  constructor(private runs: RunService) {}

  @Get()
  async list(@Param('projectSlug') projectSlug: string, @Query('limit') limit?: string) {
    return { items: await this.runs.list(projectSlug, { limit: limit ? Number(limit) : undefined }) };
  }

  @Post()
  @RequireRole('operator')
  async runNow(@Param('projectSlug') projectSlug: string) {
    return this.runs.runNow(projectSlug);
  }

  @Get(':runId')
  async detail(@Param('runId') runId: string) {
    return this.runs.get(runId);
  }

  @Get(':runId/full')
  async full(@Param('runId') runId: string) {
    return this.runs.detail(runId);
  }

  @Post(':runId/cancel')
  @RequireRole('operator')
  async cancel(@Param('runId') runId: string) {
    return this.runs.cancel(runId);
  }

  @Get(':runId/timeline')
  async timeline(@Param('runId') runId: string, @Query('after') after?: string) {
    return { items: await this.runs.timeline(runId, after) };
  }

  @Get(':runId/network-summary')
  async networkSummary(@Param('runId') runId: string) {
    return this.runs.networkSummary(runId);
  }

  @Post(':runId/intent')
  @RequireRole('operator')
  async addIntent(
    @Param('projectSlug') _projectSlug: string,
    @Param('runId') _runId: string,
    @Body() _body: { body: string },
  ) {
    // Intent items are usually attached to a project, not a specific run.
    // V1 routes them via the IntentInbox controller; this surface is reserved.
    return { ok: true };
  }
}
