import { Body, Controller, Get, Param, Patch, Post, Query, UnauthorizedException, UseGuards } from '@nestjs/common';
import { OrgService } from './org.service.js';
import { RoleGuard, RequireRole } from '../../common/role.guard.js';
import { TenantContextService } from '../../common/tenant-context.service.js';

@Controller('v1')
export class OrgController {
  constructor(private orgs: OrgService, private tenant: TenantContextService) {}

  @Get('orgs')
  async list() {
    const u = this.tenant.user();
    if (!u) throw new UnauthorizedException();
    return { items: await this.orgs.listForUser(u.userId) };
  }

  @Post('orgs')
  async create(@Body() body: { name: string; slug: string }) {
    const u = this.tenant.user();
    if (!u) throw new UnauthorizedException();
    return this.orgs.create(u.userId, body.name, body.slug);
  }

  @Get('orgs/:slug')
  async detail(@Param('slug') _slug: string) {
    return this.orgs.detail();
  }

  @Get('orgs/:slug/members')
  async members(@Param('slug') _slug: string) {
    return { items: await this.orgs.listMembers() };
  }

  @Get('orgs/:slug/budget')
  @UseGuards(RoleGuard)
  async budget(@Param('slug') _slug: string) {
    const org = await this.orgs.detail();
    const today = await this.orgs.todaysSpendUsd();
    const budget = org.dailyBudgetUsd === null ? null : Number(org.dailyBudgetUsd);
    return {
      dailyBudgetUsd: budget,
      todaysSpendUsd: today,
      remainingUsd: budget === null ? null : Math.max(0, budget - today),
      exceeded: budget !== null && today >= budget,
    };
  }

  @Patch('orgs/:slug/budget')
  @UseGuards(RoleGuard)
  @RequireRole('admin')
  async updateBudget(
    @Param('slug') _slug: string,
    @Body() body: { dailyBudgetUsd: number | null },
  ) {
    const updated = await this.orgs.updateBudget(body.dailyBudgetUsd);
    return {
      dailyBudgetUsd:
        updated.dailyBudgetUsd === null ? null : Number(updated.dailyBudgetUsd),
    };
  }

  @Get('orgs/:slug/concurrency-cap')
  @UseGuards(RoleGuard)
  async concurrencyCap(@Param('slug') _slug: string) {
    const org = await this.orgs.detail();
    return { orgConcurrencyCap: org.orgConcurrencyCap };
  }

  @Patch('orgs/:slug/concurrency-cap')
  @UseGuards(RoleGuard)
  @RequireRole('admin')
  async updateConcurrencyCap(
    @Param('slug') _slug: string,
    @Body() body: { orgConcurrencyCap: number },
  ) {
    const updated = await this.orgs.updateConcurrencyCap(body.orgConcurrencyCap);
    return { orgConcurrencyCap: updated.orgConcurrencyCap };
  }

  @UseGuards(RoleGuard)
  @RequireRole('admin')
  @Get('orgs/:slug/audit-log')
  async auditLog(@Query('limit') limit?: string) {
    return { items: await this.orgs.listAuditLog({ limit: limit ? Number(limit) : 100 }) };
  }
}
