import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { evaluateSlo, type SloMetric } from '@mergecrew/db';
import { NotFoundError, ValidationError } from '@mergecrew/domain';
import { PrismaService } from '../../common/prisma.service.js';
import { TenantContextService } from '../../common/tenant-context.service.js';
import { RoleGuard, RequireRole } from '../../common/role.guard.js';

const ALLOWED_METRICS: SloMetric[] = [
  'stepPassRate',
  'runFailureRate',
  'p95StepMs',
  'dailyCostUsd',
];
const ALLOWED_COMPARATORS = ['gte', 'lte'] as const;

type SloRow = {
  id: string;
  name: string;
  metric: SloMetric;
  comparator: 'gte' | 'lte';
  threshold: number;
  windowHours: number;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
};

type SloUpsertBody = {
  name?: string;
  metric?: string;
  comparator?: string;
  threshold?: number;
  windowHours?: number;
  enabled?: boolean;
};

@Controller('v1/orgs/:slug/projects/:projectSlug/slos')
@UseGuards(RoleGuard)
export class SloController {
  constructor(
    private prisma: PrismaService,
    private tenant: TenantContextService,
  ) {}

  @Get()
  async list(@Param('projectSlug') projectSlug: string): Promise<{
    items: Array<SloRow & { currentState: string; currentValue: number | null }>;
  }> {
    const t = this.tenant.require();
    const project = await this.resolveProject(t.organizationId, projectSlug);
    const slos = await this.prisma.withTenant(t.organizationId, (tx) =>
      tx.projectSlo.findMany({
        where: { organizationId: t.organizationId, projectId: project.id },
        orderBy: { createdAt: 'asc' },
      }),
    );
    const evaluations = await Promise.all(
      slos.map((s) =>
        s.enabled
          ? evaluateSlo({
              id: s.id,
              organizationId: t.organizationId,
              projectId: project.id,
              name: s.name,
              metric: s.metric as SloMetric,
              comparator: s.comparator as 'gte' | 'lte',
              threshold: Number(s.threshold),
              windowHours: s.windowHours,
            })
          : Promise.resolve({
              sloId: s.id,
              state: 'OK' as const,
              current: null,
              windowStart: '',
              windowEnd: '',
            }),
      ),
    );
    return {
      items: slos.map((s, i) => ({
        id: s.id,
        name: s.name,
        metric: s.metric as SloMetric,
        comparator: s.comparator as 'gte' | 'lte',
        threshold: Number(s.threshold),
        windowHours: s.windowHours,
        enabled: s.enabled,
        createdAt: s.createdAt.toISOString(),
        updatedAt: s.updatedAt.toISOString(),
        currentState: s.enabled ? evaluations[i]!.state : 'DISABLED',
        currentValue: evaluations[i]!.current,
      })),
    };
  }

  @Post()
  @RequireRole('operator')
  async create(
    @Param('projectSlug') projectSlug: string,
    @Body() body: SloUpsertBody,
  ): Promise<SloRow> {
    const t = this.tenant.require();
    const project = await this.resolveProject(t.organizationId, projectSlug);
    const input = validate(body, /* requireAll */ true);
    const row = await this.prisma.withTenant(t.organizationId, (tx) =>
      tx.projectSlo.create({
        data: {
          organizationId: t.organizationId,
          projectId: project.id,
          name: input.name!,
          metric: input.metric!,
          comparator: input.comparator!,
          threshold: input.threshold!,
          windowHours: input.windowHours!,
          enabled: input.enabled ?? true,
        },
      }),
    );
    return serialize(row);
  }

  @Patch(':sloId')
  @RequireRole('operator')
  async update(
    @Param('projectSlug') projectSlug: string,
    @Param('sloId') sloId: string,
    @Body() body: SloUpsertBody,
  ): Promise<SloRow> {
    const t = this.tenant.require();
    const project = await this.resolveProject(t.organizationId, projectSlug);
    const input = validate(body, false);
    const row = await this.prisma.withTenant(t.organizationId, async (tx) => {
      const existing = await tx.projectSlo.findFirst({
        where: { id: sloId, projectId: project.id },
      });
      if (!existing) throw new NotFoundError();
      return tx.projectSlo.update({
        where: { id: sloId },
        data: {
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.metric !== undefined ? { metric: input.metric } : {}),
          ...(input.comparator !== undefined ? { comparator: input.comparator } : {}),
          ...(input.threshold !== undefined ? { threshold: input.threshold } : {}),
          ...(input.windowHours !== undefined ? { windowHours: input.windowHours } : {}),
          ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
        },
      });
    });
    return serialize(row);
  }

  @Delete(':sloId')
  @RequireRole('operator')
  async remove(
    @Param('projectSlug') projectSlug: string,
    @Param('sloId') sloId: string,
  ): Promise<{ deleted: true }> {
    const t = this.tenant.require();
    const project = await this.resolveProject(t.organizationId, projectSlug);
    await this.prisma.withTenant(t.organizationId, async (tx) => {
      const existing = await tx.projectSlo.findFirst({
        where: { id: sloId, projectId: project.id },
      });
      if (!existing) throw new NotFoundError();
      await tx.projectSlo.delete({ where: { id: sloId } });
    });
    return { deleted: true };
  }

  private async resolveProject(
    organizationId: string,
    projectSlug: string,
  ): Promise<{ id: string }> {
    const p = await this.prisma.withTenant(organizationId, (tx) =>
      tx.project.findFirst({
        where: { slug: projectSlug, organizationId },
        select: { id: true },
      }),
    );
    if (!p) throw new NotFoundError();
    return p;
  }
}

function validate(body: SloUpsertBody, requireAll: boolean): SloUpsertBody & { metric?: SloMetric; comparator?: 'gte' | 'lte' } {
  const out: SloUpsertBody & { metric?: SloMetric; comparator?: 'gte' | 'lte' } = {};
  if (body.name !== undefined) {
    if (typeof body.name !== 'string' || body.name.trim().length === 0) {
      throw new ValidationError('name is required');
    }
    out.name = body.name.trim();
  } else if (requireAll) {
    throw new ValidationError('name is required');
  }
  if (body.metric !== undefined) {
    if (!ALLOWED_METRICS.includes(body.metric as SloMetric)) {
      throw new ValidationError(`metric must be one of ${ALLOWED_METRICS.join(', ')}`);
    }
    out.metric = body.metric as SloMetric;
  } else if (requireAll) {
    throw new ValidationError('metric is required');
  }
  if (body.comparator !== undefined) {
    if (!ALLOWED_COMPARATORS.includes(body.comparator as 'gte' | 'lte')) {
      throw new ValidationError(`comparator must be one of ${ALLOWED_COMPARATORS.join(', ')}`);
    }
    out.comparator = body.comparator as 'gte' | 'lte';
  } else if (requireAll) {
    throw new ValidationError('comparator is required');
  }
  if (body.threshold !== undefined) {
    if (typeof body.threshold !== 'number' || !Number.isFinite(body.threshold)) {
      throw new ValidationError('threshold must be a finite number');
    }
    out.threshold = body.threshold;
  } else if (requireAll) {
    throw new ValidationError('threshold is required');
  }
  if (body.windowHours !== undefined) {
    if (
      typeof body.windowHours !== 'number' ||
      !Number.isInteger(body.windowHours) ||
      body.windowHours < 1 ||
      body.windowHours > 720
    ) {
      throw new ValidationError('windowHours must be an integer between 1 and 720');
    }
    out.windowHours = body.windowHours;
  } else if (requireAll) {
    throw new ValidationError('windowHours is required');
  }
  if (body.enabled !== undefined) {
    if (typeof body.enabled !== 'boolean') {
      throw new ValidationError('enabled must be a boolean');
    }
    out.enabled = body.enabled;
  }
  return out;
}

function serialize(row: {
  id: string;
  name: string;
  metric: string;
  comparator: string;
  threshold: unknown;
  windowHours: number;
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
}): SloRow {
  return {
    id: row.id,
    name: row.name,
    metric: row.metric as SloMetric,
    comparator: row.comparator as 'gte' | 'lte',
    threshold: Number(row.threshold),
    windowHours: row.windowHours,
    enabled: row.enabled,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
