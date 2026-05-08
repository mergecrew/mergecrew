import { Injectable } from '@nestjs/common';
import { NotFoundError, GateRequiredError, type DecisionKind } from '@mergecrew/domain';
import { PrismaService } from '../../common/prisma.service.js';
import { TenantContextService } from '../../common/tenant-context.service.js';
import { QueueService } from '../../common/queue.service.js';
import { EventlogService } from '../../common/eventlog.service.js';

@Injectable()
export class ChangesetService {
  constructor(
    private prisma: PrismaService,
    private tenant: TenantContextService,
    private queue: QueueService,
    private elSvc: EventlogService,
  ) {}

  async list(projectSlug: string, opts: { status?: string; runId?: string }) {
    const t = this.tenant.require();
    const project = await this.prisma.withTenant(t.organizationId, (tx) =>
      tx.project.findFirst({ where: { slug: projectSlug, organizationId: t.organizationId } }),
    );
    if (!project) throw new NotFoundError();
    return this.prisma.withTenant(t.organizationId, (tx) =>
      tx.changeset.findMany({
        where: {
          projectId: project.id,
          ...(opts.status ? { status: opts.status as any } : {}),
          ...(opts.runId ? { dailyRunId: opts.runId } : {}),
        },
        orderBy: { updatedAt: 'desc' },
      }),
    );
  }

  async get(csId: string) {
    const t = this.tenant.require();
    const r = await this.prisma.withTenant(t.organizationId, (tx) =>
      tx.changeset.findFirst({ where: { id: csId, organizationId: t.organizationId } }),
    );
    if (!r) throw new NotFoundError();
    return r;
  }

  async digestFor(projectSlug: string, dateISO: string) {
    const t = this.tenant.require();
    const project = await this.prisma.withTenant(t.organizationId, (tx) =>
      tx.project.findFirst({ where: { slug: projectSlug, organizationId: t.organizationId } }),
    );
    if (!project) throw new NotFoundError();
    const start = new Date(dateISO);
    const end = new Date(start.getTime() + 24 * 3600_000);
    const items = await this.prisma.withTenant(t.organizationId, (tx) =>
      tx.changeset.findMany({
        where: {
          projectId: project.id,
          updatedAt: { gte: start, lt: end },
        },
        orderBy: { updatedAt: 'desc' },
      }),
    );
    return {
      date: dateISO.slice(0, 10),
      items,
      totalCost: items.reduce((s, c) => s + Number(c.estimatedUsd), 0),
    };
  }

  async decide(csId: string, kind: DecisionKind, comment?: string) {
    const t = this.tenant.require();
    const cs = await this.get(csId);

    // Hard product invariant: production promote requires operator+.
    if (kind === 'promote' && t.role !== 'owner' && t.role !== 'admin' && t.role !== 'operator') {
      throw new GateRequiredError('production_promote', 'operator');
    }

    const decision = await this.prisma.withTenant(t.organizationId, (tx) =>
      tx.decision.create({
        data: {
          organizationId: t.organizationId,
          changesetId: csId,
          userId: t.userId,
          kind,
          comment: comment ?? null,
        },
      }),
    );

    await this.prisma.withTenant(t.organizationId, (tx) =>
      tx.changeset.update({
        where: { id: csId },
        data: {
          status: kind === 'promote' ? 'promoted' : kind === 'rollback' ? 'rolled_back' : 'deferred',
          updatedAt: new Date(),
        },
      }),
    );

    if (kind === 'promote') {
      await this.queue.get('orchestrator.dispatch').add(
        'promote',
        { changesetId: csId, organizationId: t.organizationId, userId: t.userId },
        { removeOnComplete: 1000 },
      );
    } else if (kind === 'rollback') {
      await this.queue.get('orchestrator.dispatch').add(
        'rollback',
        { changesetId: csId, organizationId: t.organizationId, userId: t.userId },
        { removeOnComplete: 1000 },
      );
    }

    await this.elSvc.eventlog.emit({
      organizationId: t.organizationId,
      projectId: cs.projectId,
      dailyRunId: cs.dailyRunId,
      changesetId: csId,
      type:
        kind === 'promote'
          ? 'CHANGESET_PROMOTED'
          : kind === 'rollback'
            ? 'CHANGESET_ROLLED_BACK'
            : 'AGENT_DECISION',
      actor: { kind: 'user', id: t.userId },
      payload: { kind, comment: comment ?? null, decisionId: decision.id },
    });

    return decision;
  }

  async groupPromote(projectSlug: string, dateISO: string, ids: string[]) {
    const t = this.tenant.require();
    const project = await this.prisma.withTenant(t.organizationId, (tx) =>
      tx.project.findFirst({ where: { slug: projectSlug, organizationId: t.organizationId } }),
    );
    if (!project) throw new NotFoundError();
    const decisions: any[] = [];
    for (const id of ids) {
      decisions.push(await this.decide(id, 'promote'));
    }
    await this.queue.get('orchestrator.dispatch').add(
      'group_promote',
      { projectId: project.id, organizationId: t.organizationId, ids },
      { removeOnComplete: 1000 },
    );
    return { decisions, dateISO };
  }
}
