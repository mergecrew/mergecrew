import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import {
  computeOrgProjectsHealth,
  computeProjectHealth,
  type ProjectHealthRow,
} from '@mergecrew/db';
import { NotFoundError } from '@mergecrew/domain';
import { PrismaService } from '../../common/prisma.service.js';
import { TenantContextService } from '../../common/tenant-context.service.js';
import { RoleGuard } from '../../common/role.guard.js';

@Controller('v1/orgs/:slug')
@UseGuards(RoleGuard)
export class HealthController {
  constructor(
    private prisma: PrismaService,
    private tenant: TenantContextService,
  ) {}

  @Get('projects-health')
  async orgProjectsHealth(): Promise<{ items: ProjectHealthRow[] }> {
    const t = this.tenant.require();
    const items = await computeOrgProjectsHealth(t.organizationId);
    return { items };
  }

  @Get('projects/:projectSlug/health')
  async projectHealth(
    @Param('projectSlug') projectSlug: string,
  ): Promise<ProjectHealthRow> {
    const t = this.tenant.require();
    const project = await this.prisma.withTenant(t.organizationId, (tx) =>
      tx.project.findFirst({
        where: { slug: projectSlug, organizationId: t.organizationId },
        select: { id: true },
      }),
    );
    if (!project) throw new NotFoundError();
    const row = await computeProjectHealth(t.organizationId, project.id);
    if (!row) throw new NotFoundError();
    return row;
  }
}
