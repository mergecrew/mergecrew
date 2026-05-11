import type { Logger } from 'pino';
import type { Queue } from 'bullmq';
import { withSystem, withTenant } from '@mergecrew/db';
import type { Eventlog } from '@mergecrew/eventlog';

/**
 * Heartbeat-based dead-runner recovery (#10 V1.4).
 *
 * The runner stamps `agent_steps.heartbeat_at` every
 * `RUNNER_HEARTBEAT_INTERVAL_MS` (default 15s) while a step is executing.
 * If a runner is OOM-killed, drained mid-task by ECS, or partitioned from
 * the DB, those writes stop. The sweeper scans periodically for steps in
 * `status='running'` whose heartbeat is older than `staleAfterMs` (default
 * 90s — six heartbeat periods) and re-dispatches them.
 *
 * Recovery has a hard cap on total attempts (`maxAttempts`, default 3).
 * Beyond it the step is marked `failed` with reason `runner_dead` so a
 * loop in the user's code or a poison pill input doesn't spin forever.
 *
 * **Per-attempt exponential backoff (#189).** A poison-pill input would
 * otherwise burn through `maxAttempts` re-dispatches in `staleAfterMs *
 * maxAttempts` time (~4.5 min at defaults). To slow that down, each
 * subsequent attempt waits 2× longer than the previous before being
 * re-dispatched: 90s, 180s, 360s, … capped at one hour. The cap-reached
 * path (mark failed at maxAttempts) still fires at the base threshold so
 * operators don't have to wait for the longest backoff to learn a step
 * gave up.
 *
 * The scan itself runs from a single orchestrator instance; if multiple
 * orchestrators are running, BullMQ's job-level locks on the
 * `runner.step` queue still keep each step single-flighted, so duplicate
 * sweeper triggers are at worst wasted work.
 */
export interface HeartbeatSweeperDeps {
  runnerQueue: Queue;
  eventlog: Eventlog;
  logger: Logger;
  /** How often to scan. */
  intervalMs?: number;
  /** Mark a heartbeat stale after this many ms with no update. */
  staleAfterMs?: number;
  /** Hard cap on total attempts before we give up. */
  maxAttempts?: number;
  /**
   * Invoked after every successful tick (including ticks that found no
   * stale steps). The observability server uses this to surface a
   * `last successful tick` age in /healthz + /metrics.
   */
  onTick?: () => void;
}

export class HeartbeatSweeper {
  private timer?: NodeJS.Timeout;
  private running = false;
  private readonly intervalMs: number;
  private readonly staleAfterMs: number;
  private readonly maxAttempts: number;

  constructor(private readonly deps: HeartbeatSweeperDeps) {
    this.intervalMs = deps.intervalMs ?? 30_000;
    this.staleAfterMs = deps.staleAfterMs ?? 90_000;
    this.maxAttempts = deps.maxAttempts ?? 3;
  }

  start(): void {
    if (this.timer) return;
    // Schedule with setInterval so a missed tick doesn't stack up future
    // ones; a slow scan just delays the next one.
    this.timer = setInterval(() => {
      void this.tick();
    }, this.intervalMs);
    if (typeof this.timer.unref === 'function') this.timer.unref();
    this.deps.logger.info(
      { intervalMs: this.intervalMs, staleAfterMs: this.staleAfterMs, maxAttempts: this.maxAttempts },
      'heartbeat sweeper started',
    );
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /**
   * Per-attempt staleness threshold. Doubles each attempt (90s → 180s →
   * 360s at defaults) so a poison-pill input doesn't churn the
   * `maxAttempts` budget in a few minutes. Capped at one hour to keep
   * unbounded attempts from sleeping forever.
   */
  private staleThresholdFor(attempt: number): number {
    const exp = Math.max(0, attempt - 1);
    return Math.min(this.staleAfterMs * Math.pow(2, exp), 3_600_000);
  }

  private async tick(): Promise<void> {
    if (this.running) return; // skip overlapping runs
    this.running = true;
    try {
      const stale = await withSystem((tx) =>
        tx.agentStep.findMany({
          where: {
            status: 'running',
            heartbeatAt: { lt: new Date(Date.now() - this.staleAfterMs) },
          },
          select: {
            id: true,
            organizationId: true,
            workflowRunId: true,
            attempt: true,
            heartbeatAt: true,
            input: true,
            workflowRun: {
              select: {
                dailyRunId: true,
                dailyRun: { select: { projectId: true } },
              },
            },
          },
          take: 50, // bounded per tick
        }),
      );
      if (stale.length > 0) {
        this.deps.logger.info({ count: stale.length }, 'sweeper: stale steps detected');
        for (const step of stale) {
          await this.recoverStep(step);
        }
      }
      // Record a successful tick — readiness probes use this to detect a
      // wedged orchestrator that's still alive but no longer scanning.
      this.deps.onTick?.();
    } catch (err: any) {
      this.deps.logger.error({ err: err?.message ?? err }, 'sweeper tick failed');
    } finally {
      this.running = false;
    }
  }

  private async recoverStep(step: {
    id: string;
    organizationId: string;
    workflowRunId: string;
    attempt: number;
    heartbeatAt: Date | null;
    input: unknown;
    workflowRun: { dailyRunId: string; dailyRun: { projectId: string } };
  }): Promise<void> {
    const { id: stepId, organizationId, workflowRunId, attempt } = step;
    const projectId = step.workflowRun.dailyRun.projectId;
    const runId = step.workflowRun.dailyRunId;
    const agentRef =
      (step.input as { agentRef?: string } | null)?.agentRef ?? 'unknown';
    const staleSeconds = step.heartbeatAt
      ? Math.round((Date.now() - step.heartbeatAt.getTime()) / 1000)
      : null;

    if (attempt >= this.maxAttempts) {
      // Cap reached. Mark failed so the workflow advances rather than
      // stalling on a step nobody will pick up. Cap-reached fires at
      // the base threshold (no backoff) so operators don't wait an
      // hour to learn a poison-pill step gave up.
      await withTenant(organizationId, (tx) =>
        tx.agentStep.updateMany({
          where: { id: stepId, status: 'running' },
          data: {
            status: 'failed',
            finishedAt: new Date(),
            heartbeatAt: null,
            failureReason: `runner_dead: heartbeat stale ${staleSeconds}s, attempts ${attempt}/${this.maxAttempts}`,
          },
        }),
      );
      await this.deps.eventlog.emit({
        organizationId,
        projectId,
        dailyRunId: runId,
        workflowRunId,
        agentStepId: stepId,
        type: 'AGENT_STEP_FAILED',
        actor: { kind: 'system' },
        payload: {
          reason: 'runner_dead',
          attempts: attempt,
          staleSeconds,
        },
      });
      this.deps.logger.warn(
        { stepId, attempt, staleSeconds },
        'sweeper: step exceeded max attempts, marked failed',
      );
      return;
    }

    // Per-attempt exponential backoff before re-dispatch (#189). The SQL
    // filter picks up anything past the base threshold; once attempt >=
    // 2, hold off until the attempt-specific window has elapsed so a
    // poison-pill doesn't burn the whole budget in a few minutes.
    const ageMs =
      step.heartbeatAt ? Date.now() - step.heartbeatAt.getTime() : Number.POSITIVE_INFINITY;
    const threshold = this.staleThresholdFor(attempt);
    if (ageMs < threshold) {
      this.deps.logger.debug(
        { stepId, attempt, ageMs, threshold },
        'sweeper: still in per-attempt backoff window, skipping re-dispatch',
      );
      return;
    }

    // Re-dispatch. We DON'T flip status back to 'pending' first —
    // runner.runStep does that itself by writing 'running' on entry. We just
    // refresh the heartbeat timestamp so the next sweep doesn't immediately
    // re-trigger before the new runner picks the job up.
    await withTenant(organizationId, (tx) =>
      tx.agentStep.update({
        where: { id: stepId },
        data: { heartbeatAt: new Date() },
      }),
    );
    await this.deps.runnerQueue.add(
      'step',
      {
        organizationId,
        projectId,
        runId,
        workflowRunId,
        stepId,
        agentRef,
      },
      { removeOnComplete: 1000, removeOnFail: 1000, attempts: 1 },
    );
    await this.deps.eventlog.emit({
      organizationId,
      projectId,
      dailyRunId: runId,
      workflowRunId,
      agentStepId: stepId,
      type: 'AGENT_STEP_RECOVERED',
      actor: { kind: 'system' },
      payload: {
        priorAttempt: attempt,
        staleSeconds,
        reason: 'heartbeat_stale',
      },
    });
    this.deps.logger.info(
      { stepId, attempt, staleSeconds },
      'sweeper: re-dispatched stale step',
    );
  }
}
