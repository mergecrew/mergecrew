import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { Prisma } from '@mergecrew/db';
import { PrismaService } from '../../common/prisma.service.js';
import { TenantContextService } from '../../common/tenant-context.service.js';
import { RoleGuard } from '../../common/role.guard.js';
import { NotFoundError } from '@mergecrew/domain';

@Controller('v1/orgs/:slug')
@UseGuards(RoleGuard)
export class CostController {
  constructor(private prisma: PrismaService, private tenant: TenantContextService) {}

  @Get('costs')
  async orgCosts(@Query('days') daysQ?: string) {
    const t = this.tenant.require();
    const days = Math.min(Math.max(Number(daysQ ?? 30), 1), 90);
    const since = new Date(Date.now() - days * 86_400_000);
    const rows = await this.prisma.withTenant(t.organizationId, async (tx) => {
      return tx.$queryRaw<Array<{ day: Date; usd: number; tokens: number; provider_kind: string; model_id: string }>>(
        Prisma.sql`
          select
            date_trunc('day', occurred_at) as day,
            sum(usd_estimate)::float as usd,
            sum(input_tokens + output_tokens)::int as tokens,
            (select kind from llm_providers p where p.id = i.provider_id) as provider_kind,
            model_id
          from llm_invocations i
          where organization_id = ${t.organizationId}::uuid
            and occurred_at >= ${since}
          group by 1, 4, 5
          order by 1 desc
        `,
      );
    });
    return { days, items: rows };
  }

  @Get('projects/:projectSlug/costs')
  async projectCosts(@Param('projectSlug') projectSlug: string, @Query('days') daysQ?: string) {
    const t = this.tenant.require();
    const project = await this.prisma.withTenant(t.organizationId, (tx) =>
      tx.project.findFirst({ where: { slug: projectSlug, organizationId: t.organizationId } }),
    );
    if (!project) throw new NotFoundError();
    const days = Math.min(Math.max(Number(daysQ ?? 30), 1), 90);
    const since = new Date(Date.now() - days * 86_400_000);
    const rows = await this.prisma.withTenant(t.organizationId, async (tx) => {
      return tx.$queryRaw<Array<{ day: Date; usd: number; tokens: number }>>(
        Prisma.sql`
          select
            date_trunc('day', occurred_at) as day,
            sum(usd_estimate)::float as usd,
            sum(input_tokens + output_tokens)::int as tokens
          from llm_invocations
          where organization_id = ${t.organizationId}::uuid
            and project_id = ${project.id}::uuid
            and occurred_at >= ${since}
          group by 1
          order by 1 desc
        `,
      );
    });
    return { days, items: rows };
  }

  @Get('projects/:projectSlug/runs/:runId/costs')
  async runCosts(@Param('runId') runId: string) {
    const t = this.tenant.require();
    const rows = await this.prisma.withTenant(t.organizationId, (tx) =>
      tx.llmInvocation.findMany({
        where: { runId, organizationId: t.organizationId },
        orderBy: { occurredAt: 'asc' },
      }),
    );
    const totalUsd = rows.reduce((s, r) => s + Number(r.usdEstimate), 0);
    const totalTokens = rows.reduce((s, r) => s + r.inputTokens + r.outputTokens, 0);
    return { totalUsd, totalTokens, items: rows };
  }
}
