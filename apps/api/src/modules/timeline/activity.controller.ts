import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { PrismaService } from '../../common/prisma.service.js';
import { TenantContextService } from '../../common/tenant-context.service.js';
import { RoleGuard } from '../../common/role.guard.js';

@Controller('v1/orgs/:slug/activity')
@UseGuards(RoleGuard)
export class ActivityController {
  constructor(private prisma: PrismaService, private tenant: TenantContextService) {}

  @Get()
  async activity(@Query('limit') limit?: string) {
    const t = this.tenant.require();
    const lim = Math.min(Number(limit ?? 100), 500);
    const items = await this.prisma.withTenant(t.organizationId, (tx) =>
      tx.timelineEvent.findMany({
        where: { organizationId: t.organizationId },
        orderBy: { occurredAt: 'desc' },
        take: lim,
      }),
    );
    return { items };
  }
}
