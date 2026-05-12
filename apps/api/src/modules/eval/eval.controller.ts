import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { EvalService } from './eval.service.js';
import { RoleGuard } from '../../common/role.guard.js';

@Controller('v1/orgs/:slug/evals')
@UseGuards(RoleGuard)
export class EvalController {
  constructor(private evals: EvalService) {}

  @Get()
  async list(@Query('limit') limitQ?: string) {
    const limit = limitQ ? Number(limitQ) : 10;
    const [items, trailing] = await Promise.all([
      this.evals.list({ limit: Number.isFinite(limit) ? limit : 10 }),
      this.evals.trailingPassRate(7),
    ]);
    return { items, trailing };
  }

  @Get(':runId')
  async detail(@Param('runId') runId: string) {
    return this.evals.detail(runId);
  }
}
