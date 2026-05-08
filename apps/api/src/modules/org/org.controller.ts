import { Body, Controller, Get, Param, Post, Query, UnauthorizedException, UseGuards } from '@nestjs/common';
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

  @UseGuards(RoleGuard)
  @RequireRole('admin')
  @Get('orgs/:slug/audit-log')
  async auditLog(@Query('limit') limit?: string) {
    return { items: await this.orgs.listAuditLog({ limit: limit ? Number(limit) : 100 }) };
  }
}
