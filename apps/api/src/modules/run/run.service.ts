import { Injectable } from '@nestjs/common';
import { NotFoundError, ValidationError } from '@mergecrew/domain';
import { RUN_CANCEL_CHANNEL, type RunCancelMessage } from '@mergecrew/eventlog';
import { PrismaService } from '../../common/prisma.service.js';
import { TenantContextService } from '../../common/tenant-context.service.js';
import { QueueService } from '../../common/queue.service.js';
import { EventlogService } from '../../common/eventlog.service.js';
import { TelemetryService } from '../../common/telemetry.service.js';

@Injectable()
export class RunService {
  constructor(
    private prisma: PrismaService,
    private tenant: TenantContextService,
    private queue: QueueService,
    private eventlogSvc: EventlogService,
    private telemetry: TelemetryService,
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
        include: {
          connectedRepo: true,
          deployTargets: true,
          organization: {
            select: { runsPausedAt: true, runsPauseReason: true },
          },
        },
      }),
    );
    if (!project) throw new NotFoundError();
    // Operator kill switch (#625). Org-scope pause beats project-scope —
    // it would still be blocked at the orchestrator's defensive check
    // either way, but raising here keeps the error close to the click
    // and shows the reason in the UI tooltip.
    if (project.organization.runsPausedAt) {
      throw new ValidationError(
        `runs paused org-wide${
          project.organization.runsPauseReason ? `: ${project.organization.runsPauseReason}` : ''
        }`,
      );
    }
    if (project.runsPausedAt) {
      throw new ValidationError(
        `runs paused for this project${project.runsPauseReason ? `: ${project.runsPauseReason}` : ''}`,
      );
    }
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
    // Lifecycle precondition (#252). The orchestrator's run.due handler
    // also bails when no lifecycle exists; rejecting at the API instead
    // gives a clear error to the operator rather than a silent skip.
    const hasLifecycle = await this.prisma.withTenant(t.organizationId, async (tx) => {
      const lc = await tx.lifecycle.findFirst({
        where: { projectId: project.id },
        select: { id: true },
      });
      return lc !== null;
    });
    if (!hasLifecycle) {
      throw new ValidationError(
        'project has no lifecycle — save a mergecrew.yaml from the Lifecycle page to enable runs',
      );
    }
    // Pre-create the DailyRun row synchronously so the API can return
    // its id (#407, V2.aj). The orchestrator's run.due handler picks
    // up a row passed in via data.runId and flips it pending → running;
    // when no runId is provided (cron path) it falls back to creating
    // its own row, same as before. Lifecycle version is captured at
    // enqueue time so a mid-run YAML edit doesn't shift this run's
    // graph.
    const lifecycle = await this.prisma.withTenant(t.organizationId, (tx) =>
      tx.lifecycle.findFirst({ where: { projectId: project.id }, orderBy: { version: 'desc' } }),
    );
    if (!lifecycle) {
      // Re-checked under withTenant to satisfy the type narrowing; the
      // earlier hasLifecycle check uses the same scope, so this branch
      // is a defensive no-op.
      throw new ValidationError('project has no lifecycle');
    }
    const run = await this.prisma.withTenant(t.organizationId, (tx) =>
      tx.dailyRun.create({
        data: {
          organizationId: t.organizationId,
          projectId: project.id,
          lifecycleId: lifecycle.id,
          scheduledAt: new Date(),
          status: 'pending',
          metadata: { manual: true },
        },
      }),
    );
    await this.queue.get('run.due').add(
      'run.due',
      { organizationId: t.organizationId, projectId: project.id, runId: run.id, manual: true },
      { removeOnComplete: 1000, removeOnFail: 1000 },
    );
    return { queued: true, projectId: project.id, runId: run.id };
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

    // Run-terminal workspace cleanup — the per-run /var/mergecrew/work/<runId>/
    // tree is no longer needed once the run is cancelled. Fire-and-forget;
    // the runner consumes from this queue and rms best-effort.
    await this.queue
      .get('runner.workspace-cleanup')
      .add('cleanup', { runId }, { removeOnComplete: 1000, removeOnFail: 1000 })
      .catch(() => {
        /* the cleanup is a disk-only optimization; missing it leaks until next sweep */
      });

    void this.telemetry.emit(t.organizationId, 'run.completed', { status: 'cancelled' });
    return { cancelled: true };
  }

  async timeline(runId: string, afterEventId?: string) {
    const t = this.tenant.require();
    return this.eventlogSvc.eventlog.replayRun(t.organizationId, runId, afterEventId);
  }

  /**
   * Per-run network summary (#576). Aggregates the `egress_events` rows
   * the runner emits for every allow/deny decision into one row per host
   * so the run-detail "Network" section can render a compact list.
   *
   * Returned `mode` is the strictest mode across the run's events: any
   * 'enforced' entry means *some* layer actually dropped traffic; if
   * every entry is 'audit' the UI shows the would-have-been-blocked
   * chip.
   */
  async networkSummary(runId: string) {
    const t = this.tenant.require();
    const run = await this.prisma.withTenant(t.organizationId, (tx) =>
      tx.dailyRun.findFirst({
        where: { id: runId, organizationId: t.organizationId },
        select: { id: true, projectId: true },
      }),
    );
    if (!run) throw new NotFoundError();
    const events = await this.prisma.withTenant(t.organizationId, (tx) =>
      tx.egressEvent.findMany({
        where: { dailyRunId: runId },
        orderBy: { occurredAt: 'asc' },
      }),
    );
    const hosts = new Map<
      string,
      {
        host: string;
        attempts: number;
        allowed: number;
        blocked: number;
        firstSeen: string;
        lastSeen: string;
        reasons: Set<string>;
        sources: Set<string>;
        origins: Set<string>;
        modes: Set<string>;
      }
    >();
    let anyEnforced = false;
    let anyAudit = false;
    for (const e of events) {
      const key = e.host;
      let row = hosts.get(key);
      if (!row) {
        row = {
          host: key,
          attempts: 0,
          allowed: 0,
          blocked: 0,
          firstSeen: e.occurredAt.toISOString(),
          lastSeen: e.occurredAt.toISOString(),
          reasons: new Set<string>(),
          sources: new Set<string>(),
          origins: new Set<string>(),
          modes: new Set<string>(),
        };
        hosts.set(key, row);
      }
      row.attempts += 1;
      if (e.decision === 'blocked') row.blocked += 1;
      else row.allowed += 1;
      row.reasons.add(e.reason);
      row.sources.add(e.source);
      if (e.origin) row.origins.add(e.origin);
      row.modes.add(e.mode);
      row.lastSeen = e.occurredAt.toISOString();
      if (e.mode === 'enforced') anyEnforced = true;
      if (e.mode === 'audit') anyAudit = true;
    }
    const items = Array.from(hosts.values())
      .map((r) => ({
        host: r.host,
        attempts: r.attempts,
        allowed: r.allowed,
        blocked: r.blocked,
        firstSeen: r.firstSeen,
        lastSeen: r.lastSeen,
        reasons: Array.from(r.reasons),
        sources: Array.from(r.sources),
        origins: Array.from(r.origins),
        modes: Array.from(r.modes),
      }))
      // Blocked hosts first; then by attempts desc; then by host.
      .sort((a, b) => {
        if (a.blocked !== b.blocked) return b.blocked - a.blocked;
        if (a.attempts !== b.attempts) return b.attempts - a.attempts;
        return a.host.localeCompare(b.host);
      });
    // Enforcement mode for the whole run: prefer 'enforced' if anything
    // actually dropped; otherwise 'audit' if anyAudit; otherwise null
    // (no events captured at all).
    const mode: 'enforced' | 'audit' | null = anyEnforced ? 'enforced' : anyAudit ? 'audit' : null;
    const totals = items.reduce(
      (acc, r) => {
        acc.attempts += r.attempts;
        acc.allowed += r.allowed;
        acc.blocked += r.blocked;
        return acc;
      },
      { attempts: 0, allowed: 0, blocked: 0 },
    );
    return { runId, projectId: run.projectId, mode, totals, items };
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
