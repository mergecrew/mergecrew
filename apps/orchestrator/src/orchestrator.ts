import { Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import type { Logger } from 'pino';
import { withTenant } from '@mergecrew/db';
import type { Eventlog } from '@mergecrew/eventlog';
import type { MergecrewConfig } from '@mergecrew/domain';
import { newRunIdForDate, shortId } from '@mergecrew/domain';
import { syncLifecycleFromRepo } from './lifecycle-sync.js';
import { dispatchSlackDigest } from './digest-slack.js';
import { dispatchEmailDigest } from './digest-email.js';
import { handleSlackInteractivity } from './slack-interactivity.js';

interface OrchestratorDeps {
  connection: Redis;
  eventlog: Eventlog;
  logger: Logger;
}

export class Orchestrator {
  private runner: Queue;
  private wake: Queue;
  private digestSlack: Queue;
  private digestEmail: Queue;

  private dispatchQueue: Queue;

  constructor(private deps: OrchestratorDeps) {
    this.runner = new Queue('runner.step', { connection: deps.connection });
    this.wake = new Queue('orchestrator.rate-limit.resume', { connection: deps.connection });
    this.digestSlack = new Queue('digest.slack', { connection: deps.connection });
    this.digestEmail = new Queue('digest.email', { connection: deps.connection });
    this.dispatchQueue = new Queue('orchestrator.dispatch', { connection: deps.connection });
  }

  // ─── 1. Run start ───────────────────────────────────────────────────────

  async handleRunDue(data: { organizationId: string; projectId: string; manual?: boolean }): Promise<void> {
    const { organizationId, projectId } = data;

    // Pull the project's mergecrew.yaml from its repo and persist a new
    // Lifecycle version if it changed. Best-effort — failures fall through
    // to whatever lifecycle version is already in the DB.
    await syncLifecycleFromRepo({
      organizationId,
      projectId,
      logger: this.deps.logger,
    }).catch((err) => {
      this.deps.logger.warn({ err: err?.message ?? err, projectId }, 'lifecycle-sync: unexpected error');
    });

    const lc = await withTenant(organizationId, (tx) =>
      tx.lifecycle.findFirst({ where: { projectId }, orderBy: { version: 'desc' } }),
    );
    if (!lc) {
      this.deps.logger.warn({ projectId }, 'run.due: no lifecycle');
      return;
    }
    const project = await withTenant(organizationId, (tx) => tx.project.findUnique({ where: { id: projectId } }));
    if (!project) return;

    const inflight = await withTenant(organizationId, (tx) =>
      tx.dailyRun.findFirst({
        where: { projectId, status: { in: ['pending', 'running', 'paused_rate_limit', 'paused_gate'] } },
        orderBy: { scheduledAt: 'desc' },
      }),
    );
    if (inflight) {
      this.deps.logger.info({ runId: inflight.id }, 'run already in flight; skipping');
      return;
    }

    const run = await withTenant(organizationId, (tx) =>
      tx.dailyRun.create({
        data: {
          organizationId,
          projectId,
          lifecycleId: lc.id,
          scheduledAt: new Date(),
          status: 'running',
          startedAt: new Date(),
          metadata: { manual: !!data.manual },
        },
      }),
    );
    await withTenant(organizationId, (tx) =>
      tx.dailyRun.update({ where: { id: run.id }, data: { id: run.id } }), // no-op; placeholder
    );

    await this.deps.eventlog.emit({
      organizationId,
      projectId,
      dailyRunId: run.id,
      type: 'RUN_STARTED',
      actor: { kind: 'system' },
      payload: { manual: !!data.manual, lifecycleVersion: lc.version },
    });

    const cfg = lc.parsed as MergecrewConfig;
    const first = cfg.lifecycle.workflows[0];
    if (!first) return;
    await this.startWorkflow(organizationId, projectId, run.id, first.id);
  }

  // ─── 2. Workflow / step dispatch ────────────────────────────────────────

  async startWorkflow(
    organizationId: string,
    projectId: string,
    runId: string,
    workflowId: string,
    parentWorkflowRunId?: string,
  ): Promise<string> {
    const wfr = await withTenant(organizationId, (tx) =>
      tx.workflowRun.create({
        data: {
          organizationId,
          dailyRunId: runId,
          workflowId,
          parentWorkflowRunId: parentWorkflowRunId ?? null,
          status: 'running',
          startedAt: new Date(),
        },
      }),
    );
    await this.deps.eventlog.emit({
      organizationId,
      projectId,
      dailyRunId: runId,
      workflowRunId: wfr.id,
      type: 'WORKFLOW_STARTED',
      actor: { kind: 'system' },
      payload: { workflowId },
    });

    // Dispatch one step per agent. The workflow's parsed config is fetched via the daily run's lifecycle.
    const lc = await withTenant(organizationId, (tx) =>
      tx.lifecycle.findFirst({
        where: { projectId },
        orderBy: { version: 'desc' },
      }),
    );
    const cfg = (lc?.parsed ?? {}) as MergecrewConfig;
    const wf = cfg.lifecycle?.workflows?.find((w) => w.id === workflowId);
    if (!wf) {
      await this.completeWorkflow(organizationId, projectId, runId, wfr.id, 'no-such-workflow');
      return wfr.id;
    }
    for (const agentRef of wf.agents) {
      await this.dispatchAgentStep(organizationId, projectId, runId, wfr.id, agentRef, cfg);
    }
    return wfr.id;
  }

  private async dispatchAgentStep(
    organizationId: string,
    projectId: string,
    runId: string,
    workflowRunId: string,
    agentRef: string,
    cfg: MergecrewConfig,
  ) {
    const agentDef = cfg.agents?.[agentRef];
    if (!agentDef) {
      this.deps.logger.warn({ agentRef }, 'unknown agent ref');
      return;
    }
    const step = await withTenant(organizationId, (tx) =>
      tx.agentStep.create({
        data: {
          organizationId,
          workflowRunId,
          agentKind: agentDef.kind,
          agentInstanceId: stableUuid(`${projectId}:${agentRef}`),
          status: 'pending',
          input: { agentRef, workflowRunId },
        },
      }),
    );
    await this.runner.add(
      'step',
      {
        organizationId,
        projectId,
        runId,
        workflowRunId,
        stepId: step.id,
        agentRef,
      },
      { removeOnComplete: 1000, removeOnFail: 1000, attempts: 1 },
    );
  }

  // ─── 3. Step reply (sent by runner) ─────────────────────────────────────

  async onStepReply(data: {
    organizationId: string;
    projectId: string;
    runId: string;
    workflowRunId: string;
    stepId: string;
    outcome:
      | { kind: 'completed'; output?: unknown; toolCallsMade?: number; totalTokens?: number }
      | { kind: 'failed'; reason: string }
      | { kind: 'rate_limited'; retryAfterMs: number; providerKind?: string }
      | { kind: 'gated_reject'; reason: string }
      | { kind: 'cancelled' }
      | { kind: 'budget_exhausted'; reason?: string };
  }): Promise<void> {
    const { organizationId, projectId, runId, workflowRunId, stepId, outcome } = data;
    if (outcome.kind === 'rate_limited') {
      await withTenant(organizationId, (tx) =>
        tx.runPause.create({
          data: {
            organizationId,
            dailyRunId: runId,
            stepId,
            kind: 'rate_limit',
            wakeAt: new Date(Date.now() + outcome.retryAfterMs + Math.floor(Math.random() * 30_000)),
          },
        }),
      );
      await withTenant(organizationId, (tx) =>
        tx.dailyRun.update({ where: { id: runId }, data: { status: 'paused_rate_limit' } }),
      );
      await this.deps.eventlog.emit({
        organizationId,
        projectId,
        dailyRunId: runId,
        agentStepId: stepId,
        type: 'RUN_PAUSED_RATE_LIMIT',
        actor: { kind: 'system' },
        payload: outcome,
      });
      // Schedule a wake-up.
      await this.wake.add(
        'wake',
        { runId, stepId, organizationId, projectId, workflowRunId },
        { delay: outcome.retryAfterMs + 1000, removeOnComplete: 1000 },
      );
      return;
    }
    if (outcome.kind === 'completed') {
      await withTenant(organizationId, (tx) =>
        tx.agentStep.update({
          where: { id: stepId },
          data: { status: 'done', finishedAt: new Date(), output: (outcome.output ?? null) as any },
        }),
      );
      await this.deps.eventlog.emit({
        organizationId,
        projectId,
        dailyRunId: runId,
        agentStepId: stepId,
        type: 'AGENT_STEP_COMPLETED',
        actor: { kind: 'system' },
        payload: { totalTokens: outcome.totalTokens },
      });
      await this.maybeAdvanceWorkflow(organizationId, projectId, runId, workflowRunId);
      return;
    }
    if (outcome.kind === 'gated_reject') {
      await withTenant(organizationId, (tx) =>
        tx.agentStep.update({
          where: { id: stepId },
          data: { status: 'failed', failureReason: outcome.reason, finishedAt: new Date() },
        }),
      );
      await this.deps.eventlog.emit({
        organizationId,
        projectId,
        dailyRunId: runId,
        agentStepId: stepId,
        type: 'AGENT_STEP_FAILED',
        actor: { kind: 'system' },
        payload: { reason: outcome.reason },
      });
      await this.maybeAdvanceWorkflow(organizationId, projectId, runId, workflowRunId);
      return;
    }
    if (outcome.kind === 'failed' || outcome.kind === 'budget_exhausted' || outcome.kind === 'cancelled') {
      await withTenant(organizationId, (tx) =>
        tx.agentStep.update({
          where: { id: stepId },
          data: {
            status: outcome.kind === 'cancelled' ? 'cancelled' : 'failed',
            failureReason: (outcome as any).reason ?? outcome.kind,
            finishedAt: new Date(),
          },
        }),
      );
      await this.deps.eventlog.emit({
        organizationId,
        projectId,
        dailyRunId: runId,
        agentStepId: stepId,
        type: 'AGENT_STEP_FAILED',
        actor: { kind: 'system' },
        payload: { reason: (outcome as any).reason ?? outcome.kind },
      });
      await this.maybeAdvanceWorkflow(organizationId, projectId, runId, workflowRunId);
      return;
    }
  }

  // ─── 4. Workflow advance ────────────────────────────────────────────────

  private async maybeAdvanceWorkflow(
    organizationId: string,
    projectId: string,
    runId: string,
    workflowRunId: string,
  ) {
    const remaining = await withTenant(organizationId, (tx) =>
      tx.agentStep.count({
        where: { workflowRunId, status: { in: ['pending', 'running'] } },
      }),
    );
    if (remaining > 0) return;

    const wfr = await withTenant(organizationId, (tx) =>
      tx.workflowRun.findUnique({ where: { id: workflowRunId } }),
    );
    if (!wfr) return;

    await withTenant(organizationId, (tx) =>
      tx.workflowRun.update({
        where: { id: workflowRunId },
        data: { status: 'done', finishedAt: new Date() },
      }),
    );
    await this.deps.eventlog.emit({
      organizationId,
      projectId,
      dailyRunId: runId,
      workflowRunId,
      type: 'WORKFLOW_COMPLETED',
      actor: { kind: 'system' },
      payload: { workflowId: wfr.workflowId },
    });

    const lc = await withTenant(organizationId, (tx) =>
      tx.lifecycle.findFirst({ where: { projectId }, orderBy: { version: 'desc' } }),
    );
    const cfg = (lc?.parsed ?? {}) as MergecrewConfig;
    const wf = cfg.lifecycle.workflows.find((w) => w.id === wfr.workflowId);
    const next = wf?.out ?? [];
    if (next.length === 0) {
      await this.completeRun(organizationId, projectId, runId);
      return;
    }
    for (const n of next) {
      await this.startWorkflow(organizationId, projectId, runId, n);
    }
  }

  private async completeWorkflow(
    organizationId: string,
    projectId: string,
    runId: string,
    workflowRunId: string,
    reason: string,
  ) {
    await withTenant(organizationId, (tx) =>
      tx.workflowRun.update({
        where: { id: workflowRunId },
        data: { status: 'failed', finishedAt: new Date() },
      }),
    );
    await this.deps.eventlog.emit({
      organizationId,
      projectId,
      dailyRunId: runId,
      workflowRunId,
      type: 'WORKFLOW_COMPLETED',
      actor: { kind: 'system' },
      payload: { reason },
    });
  }

  private async completeRun(organizationId: string, projectId: string, runId: string) {
    await withTenant(organizationId, (tx) =>
      tx.dailyRun.update({
        where: { id: runId },
        data: { status: 'done', finishedAt: new Date() },
      }),
    );
    await this.deps.eventlog.emit({
      organizationId,
      projectId,
      dailyRunId: runId,
      type: 'RUN_COMPLETED',
      actor: { kind: 'system' },
      payload: {},
    });
  }

  // ─── 5. Resumes ─────────────────────────────────────────────────────────

  async resumeRateLimit(data: {
    organizationId: string;
    projectId: string;
    runId: string;
    stepId: string;
    workflowRunId: string;
  }): Promise<void> {
    await withTenant(data.organizationId, (tx) =>
      tx.runPause.updateMany({
        where: { dailyRunId: data.runId, stepId: data.stepId, resumedAt: null, kind: 'rate_limit' },
        data: { resumedAt: new Date() },
      }),
    );
    await withTenant(data.organizationId, (tx) =>
      tx.dailyRun.update({
        where: { id: data.runId },
        data: { status: 'running' },
      }),
    );
    await this.deps.eventlog.emit({
      organizationId: data.organizationId,
      projectId: data.projectId,
      dailyRunId: data.runId,
      agentStepId: data.stepId,
      type: 'RUN_RESUMED',
      actor: { kind: 'system' },
      payload: {},
    });
    // Re-dispatch the step with same input (idempotent for the runner).
    const step = await withTenant(data.organizationId, (tx) =>
      tx.agentStep.findUnique({ where: { id: data.stepId } }),
    );
    if (!step) return;
    const input = step.input as any;
    await this.runner.add(
      'step',
      {
        organizationId: data.organizationId,
        projectId: data.projectId,
        runId: data.runId,
        workflowRunId: data.workflowRunId,
        stepId: data.stepId,
        agentRef: input?.agentRef,
      },
      { removeOnComplete: 1000 },
    );
  }

  async resumeGate(data: { approvalId: string; resolution: 'approve' | 'reject' | 'takeover' }): Promise<void> {
    // Find the approval, mark related run as resumed, redispatch.
    // We use system bypass to find the org first; once known we use tenant scope.
    const ar = await (await import('@mergecrew/db')).withSystem((tx) =>
      tx.approvalRequest.findUnique({ where: { id: data.approvalId } }),
    );
    if (!ar) return;
    if (data.resolution !== 'approve') return; // reject/takeover stop the workflow
    await withTenant(ar.organizationId, (tx) =>
      tx.runPause.updateMany({
        where: { approvalRequestId: ar.id, resumedAt: null, kind: 'gate' },
        data: { resumedAt: new Date() },
      }),
    );
    await withTenant(ar.organizationId, (tx) =>
      tx.dailyRun.updateMany({
        where: { id: { not: undefined }, status: 'paused_gate' },
        data: { status: 'running' },
      }),
    );
  }

  // ─── 6. Dispatch (manual operations) ────────────────────────────────────

  async handleDispatch(name: string, data: any): Promise<void> {
    if (name === 'promote') {
      await this.deps.eventlog.emit({
        organizationId: data.organizationId,
        projectId: data.projectId ?? '',
        changesetId: data.changesetId,
        type: 'CHANGESET_PROMOTED',
        actor: { kind: 'user', id: data.userId },
        payload: { changesetId: data.changesetId },
      });
      // The dev->prod adapter call lives in the runner via a synthetic step.
    }
    if (name === 'rollback') {
      await this.deps.eventlog.emit({
        organizationId: data.organizationId,
        projectId: data.projectId ?? '',
        changesetId: data.changesetId,
        type: 'CHANGESET_ROLLED_BACK',
        actor: { kind: 'user', id: data.userId },
        payload: { changesetId: data.changesetId },
      });
    }
  }

  async handleWebhook(name: string, data: any): Promise<void> {
    this.deps.logger.info({ name }, 'webhook received');
    if (name === 'slack') {
      await handleSlackInteractivity(data?.event, {
        logger: this.deps.logger,
        eventlog: this.deps.eventlog,
        dispatchQueue: this.dispatchQueue,
      });
      return;
    }
    // Other webhooks feed the Discovery agent's input on the next run.
  }

  // ─── Digest ─────────────────────────────────────────────────────────────

  /**
   * End-of-day digest dispatcher. The worker-cron `digestTick` enqueues
   * one of these per project at end-of-working-hours; we fan-out into the
   * configured channels. Email (#82) and per-org Slack workspace install
   * (#93) are still pending — for now Slack uses a global bot token.
   */
  async handleDigestDispatch(data: { organizationId: string; projectId: string; eod: string }): Promise<void> {
    const { organizationId, projectId, eod } = data;
    const channels: string[] = [];

    if (process.env.SLACK_BOT_TOKEN) {
      await this.digestSlack.add(
        'digest.slack',
        { organizationId, projectId, eod },
        { removeOnComplete: 1000, attempts: 3, backoff: { type: 'exponential', delay: 5_000 } },
      );
      channels.push('slack');
    } else {
      this.deps.logger.info({ projectId }, 'digest.dispatch: SLACK_BOT_TOKEN not set; skipping slack');
    }

    // Email opt-in: SMTP_URL configured in any env, or DIGEST_EMAIL_ENABLED=1
    // (the latter routes to the dev-mode console-logger inside EmailClient).
    if (process.env.SMTP_URL || process.env.DIGEST_EMAIL_ENABLED === '1') {
      await this.digestEmail.add(
        'digest.email',
        { organizationId, projectId, eod },
        { removeOnComplete: 1000, attempts: 3, backoff: { type: 'exponential', delay: 5_000 } },
      );
      channels.push('email');
    } else {
      this.deps.logger.info({ projectId }, 'digest.dispatch: email not enabled; skipping');
    }

    await this.deps.eventlog.emit({
      organizationId,
      projectId,
      type: 'DIGEST_DISPATCHED',
      actor: { kind: 'system' },
      payload: { eod, channels },
    });
  }

  /**
   * Slack-channel fan-out. Loads project members + active changesets,
   * builds a block-kit digest, then DMs each member by email lookup.
   * Per-recipient errors are logged but don't fail the job — partial
   * delivery is better than retrying the whole thing.
   */
  async handleSlackDigest(data: { organizationId: string; projectId: string; eod: string }): Promise<void> {
    await dispatchSlackDigest({
      organizationId: data.organizationId,
      projectId: data.projectId,
      eod: new Date(data.eod),
      logger: this.deps.logger,
    });
  }

  /**
   * Email-channel fan-out. Loads project + active changesets, renders the
   * HTML digest template, and sends one email to all org members with a
   * resolvable email. Bounces/rejects are nodemailer's problem; the worker
   * retries on transport failure.
   */
  async handleEmailDigest(data: { organizationId: string; projectId: string; eod: string }): Promise<void> {
    await dispatchEmailDigest({
      organizationId: data.organizationId,
      projectId: data.projectId,
      eod: new Date(data.eod),
      logger: this.deps.logger,
    });
  }
}

function stableUuid(s: string): string {
  // Tiny deterministic UUID-like id for in-memory references.
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h << 5) - h + s.charCodeAt(i);
  return `00000000-0000-4000-a000-${(Math.abs(h) >>> 0).toString(16).padStart(12, '0')}`;
}

export { newRunIdForDate, shortId };
