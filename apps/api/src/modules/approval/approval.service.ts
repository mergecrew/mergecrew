import { Injectable } from '@nestjs/common';
import { ForbiddenError, NotFoundError, type GateDecision } from '@mergecrew/domain';
import { PrismaService } from '../../common/prisma.service.js';
import { TenantContextService } from '../../common/tenant-context.service.js';
import { QueueService } from '../../common/queue.service.js';
import { EventlogService } from '../../common/eventlog.service.js';

@Injectable()
export class ApprovalService {
  constructor(
    private prisma: PrismaService,
    private tenant: TenantContextService,
    private queue: QueueService,
    private elSvc: EventlogService,
  ) {}

  async listInbox() {
    const t = this.tenant.require();
    const rows = await this.prisma.withTenant(t.organizationId, (tx) =>
      tx.approvalRequest.findMany({
        where: { organizationId: t.organizationId, resolvedAt: null },
        orderBy: { createdAt: 'asc' },
        include: { project: { select: { slug: true } } },
      }),
    );
    // Flatten the project slug into the response so the inbox UI can
    // link directly to the changeset detail page (#286) without a
    // round-trip per row.
    return rows.map(({ project, ...r }) => ({ ...r, projectSlug: project?.slug ?? null }));
  }

  async listForProject(projectSlug: string) {
    const t = this.tenant.require();
    const project = await this.prisma.withTenant(t.organizationId, (tx) =>
      tx.project.findFirst({ where: { slug: projectSlug, organizationId: t.organizationId } }),
    );
    if (!project) throw new NotFoundError();
    return this.prisma.withTenant(t.organizationId, (tx) =>
      tx.approvalRequest.findMany({
        where: { projectId: project.id, resolvedAt: null },
        orderBy: { createdAt: 'asc' },
      }),
    );
  }

  async resolve(approvalId: string, resolution: GateDecision, _comment?: string) {
    const t = this.tenant.require();
    const ar = await this.prisma.withTenant(t.organizationId, (tx) =>
      tx.approvalRequest.findFirst({ where: { id: approvalId, organizationId: t.organizationId } }),
    );
    if (!ar) throw new NotFoundError();
    if (ar.resolvedAt) throw new ForbiddenError('already resolved');

    await this.prisma.withTenant(t.organizationId, (tx) =>
      tx.approvalRequest.update({
        where: { id: approvalId },
        data: {
          resolvedAt: new Date(),
          resolvedByUserId: t.userId,
          resolution,
        },
      }),
    );

    await this.queue.get('orchestrator.gate.resume').add(
      'gate.resume',
      { approvalId, resolution },
      { removeOnComplete: 1000 },
    );

    await this.elSvc.eventlog.emit({
      organizationId: t.organizationId,
      projectId: ar.projectId,
      workflowRunId: ar.workflowRunId,
      changesetId: ar.changesetId ?? null,
      type: resolution === 'approve' ? 'HUMAN_APPROVED' : 'HUMAN_REJECTED',
      actor: { kind: 'user', id: t.userId },
      payload: { resolution },
    });

    return { ok: true };
  }
}
