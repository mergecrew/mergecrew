import { Injectable } from '@nestjs/common';
import { NotFoundError, ValidationError } from '@mergecrew/domain';
import { RUN_CANCEL_CHANNEL, type RunCancelMessage } from '@mergecrew/eventlog';
import { PrismaService } from '../../common/prisma.service.js';
import { TenantContextService } from '../../common/tenant-context.service.js';
import { QueueService } from '../../common/queue.service.js';
import { EventlogService } from '../../common/eventlog.service.js';

@Injectable()
export class RunService {
  constructor(
    private prisma: PrismaService,
    private tenant: TenantContextService,
    private queue: QueueService,
    private eventlogSvc: EventlogService,
  ) {}

  async list(projectSlug: string, opts: { limit?: number }) {
    const t = this.tenant.require();
    const project = await this.prisma.withTenant(t.organizationId, (tx) =>
      tx.project.findFirst({ where: { slug: projectSlug, organizationId: t.organizationId } }),
    );
    if (!project) throw new NotFoundError();
    return this.prisma.withTenant(t.organizationId, (tx) =>
      tx.dailyRun.findMany({
        where: { projectId: project.id },
        orderBy: { scheduledAt: 'desc' },
        take: opts.limit ?? 30,
      }),
    );
  }

  async get(runId: string) {
    const t = this.tenant.require();
    const run = await this.prisma.withTenant(t.organizationId, (tx) =>
      tx.dailyRun.findFirst({ where: { id: runId, organizationId: t.organizationId } }),
    );
    if (!run) throw new NotFoundError();
    return run;
  }

  /**
   * Enqueue a "Run now" event for the orchestrator.
   *
   * Preconditions checked here (rather than letting orchestrator silently
   * skip): the project must have a connected repo and a dev deploy target.
   * #229 lets the onboarding wizard finish without these — but the run
   * surfaces (this and the cron scheduler) stay disabled until the
   * operator wires them up, so we return a clear ValidationError instead
   * of a vague 500 / dropped job.
   */
  async runNow(projectSlug: string) {
    const t = this.tenant.require();
    const project = await this.prisma.withTenant(t.organizationId, (tx) =>
      tx.project.findFirst({
        where: { slug: projectSlug, organizationId: t.organizationId },
        include: { connectedRepo: true, deployTargets: true },
      }),
    );
    if (!project) throw new NotFoundError();
    if (!project.connectedRepo) {
      throw new ValidationError(
        'project is paused — connect a GitHub repo from Settings → Integrations to enable runs',
      );
    }
    const hasDevTarget = project.deployTargets.some((dt) => dt.kind === 'dev');
    if (!hasDevTarget) {
      throw new ValidationError(
        'project is paused — add a dev deploy target from Settings → Deploy targets to enable runs',
      );
    }
    await this.queue.get('run.due').add(
      'run.due',
      { organizationId: t.organizationId, projectId: project.id, manual: true },
      { removeOnComplete: 1000, removeOnFail: 1000 },
    );
    return { queued: true, projectId: project.id };
  }

  async cancel(runId: string) {
    const t = this.tenant.require();
    await this.prisma.withTenant(t.organizationId, (tx) =>
      tx.dailyRun.update({
        where: { id: runId },
        data: { status: 'cancelled', finishedAt: new Date() },
      }),
    );
    await this.eventlogSvc.eventlog.emit({
      organizationId: t.organizationId,
      projectId: (await this.get(runId)).projectId,
      dailyRunId: runId,
      type: 'RUN_CANCELLED',
      actor: { kind: 'user', id: t.userId },
    });

    // V1.3: tell every runner to abort in-flight steps for this run, and
    // every orchestrator to drop queued dispatches. Best-effort fire and
    // forget — the DB status flip above is the source of truth, the
    // pubsub is just the fast path.
    const cancelMsg: RunCancelMessage = {
      organizationId: t.organizationId,
      runId,
      reason: `cancelled by user ${t.userId}`,
    };
    await this.eventlogSvc
      .pubsubHandle()
      .publish(RUN_CANCEL_CHANNEL, cancelMsg)
      .catch(() => {
        /* the DB flip already persisted; runners will pick up at next heartbeat sweep */
      });

    return { cancelled: true };
  }

  async timeline(runId: string, afterEventId?: string) {
    const t = this.tenant.require();
    return this.eventlogSvc.eventlog.replayRun(t.organizationId, runId, afterEventId);
  }

  /**
   * Returns the run as a tree of workflows → agent steps → (model turns + tool calls).
   * Used by the run-detail page to show what the agents actually did.
   */
  async detail(runId: string) {
    const t = this.tenant.require();
    const run = await this.prisma.withTenant(t.organizationId, (tx) =>
      tx.dailyRun.findFirst({ where: { id: runId, organizationId: t.organizationId } }),
    );
    if (!run) throw new NotFoundError();

    const workflows = await this.prisma.withTenant(t.organizationId, (tx) =>
      tx.workflowRun.findMany({
        where: { dailyRunId: runId },
        orderBy: { startedAt: 'asc' },
      }),
    );
    const wfIds = workflows.map((w) => w.id);
    const steps = await this.prisma.withTenant(t.organizationId, (tx) =>
      tx.agentStep.findMany({
        where: { workflowRunId: { in: wfIds } },
        orderBy: { startedAt: 'asc' },
      }),
    );
    const stepIds = steps.map((s) => s.id);
    const [turns, tools] = await Promise.all([
      this.prisma.withTenant(t.organizationId, (tx) =>
        tx.modelTurn.findMany({
          where: { agentStepId: { in: stepIds } },
          orderBy: [{ agentStepId: 'asc' }, { sequence: 'asc' }],
        }),
      ),
      this.prisma.withTenant(t.organizationId, (tx) =>
        tx.toolCall.findMany({
          where: { agentStepId: { in: stepIds } },
          orderBy: [{ agentStepId: 'asc' }, { sequence: 'asc' }],
        }),
      ),
    ]);

    const turnsByStep = new Map<string, typeof turns>();
    for (const tn of turns) {
      const arr = turnsByStep.get(tn.agentStepId) ?? [];
      arr.push(tn);
      turnsByStep.set(tn.agentStepId, arr);
    }
    const toolsByStep = new Map<string, typeof tools>();
    for (const tc of tools) {
      const arr = toolsByStep.get(tc.agentStepId) ?? [];
      arr.push(tc);
      toolsByStep.set(tc.agentStepId, arr);
    }
    const stepsByWf = new Map<string, typeof steps>();
    for (const s of steps) {
      const arr = stepsByWf.get(s.workflowRunId) ?? [];
      arr.push(s);
      stepsByWf.set(s.workflowRunId, arr);
    }

    return {
      run,
      workflows: workflows.map((w) => ({
        ...w,
        agentSteps: (stepsByWf.get(w.id) ?? []).map((s) => ({
          ...s,
          totalUsdEstimate: Number(s.totalUsdEstimate),
          modelTurns: (turnsByStep.get(s.id) ?? []).map((t) => ({
            ...t,
            usdEstimate: Number(t.usdEstimate),
          })),
          toolCalls: toolsByStep.get(s.id) ?? [],
        })),
      })),
    };
  }
}
