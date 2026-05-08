import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { PrismaService } from '../../common/prisma.service.js';
import { TenantContextService } from '../../common/tenant-context.service.js';
import { RequireRole, RoleGuard } from '../../common/role.guard.js';
import { NotFoundError } from '@mergecrew/domain';

@Controller('v1/orgs/:slug/projects/:projectSlug/intent-inbox')
@UseGuards(RoleGuard)
export class IntentInboxController {
  constructor(private prisma: PrismaService, private tenant: TenantContextService) {}

  @Get()
  async list(@Param('projectSlug') projectSlug: string) {
    const t = this.tenant.require();
    const project = await this.prisma.withTenant(t.organizationId, (tx) =>
      tx.project.findFirst({ where: { slug: projectSlug, organizationId: t.organizationId } }),
    );
    if (!project) throw new NotFoundError();
    const items = await this.prisma.withTenant(t.organizationId, (tx) =>
      tx.intentInboxItem.findMany({
        where: { projectId: project.id },
        orderBy: { createdAt: 'desc' },
      }),
    );
    return { items };
  }

  @Post()
  @RequireRole('operator')
  async create(
    @Param('projectSlug') projectSlug: string,
    @Body() body: { body: string },
  ) {
    const t = this.tenant.require();
    const project = await this.prisma.withTenant(t.organizationId, (tx) =>
      tx.project.findFirst({ where: { slug: projectSlug, organizationId: t.organizationId } }),
    );
    if (!project) throw new NotFoundError();
    const created = await this.prisma.withTenant(t.organizationId, (tx) =>
      tx.intentInboxItem.create({
        data: {
          organizationId: t.organizationId,
          projectId: project.id,
          submittedByUserId: t.userId,
          body: body.body,
        },
      }),
    );
    return created;
  }
}
