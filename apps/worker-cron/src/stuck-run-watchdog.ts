import type { Logger } from 'pino';
import { withSystem, withTenant } from '@mergecrew/db';
import type { Eventlog } from '@mergecrew/eventlog';

/**
 * Default thresholds. Overridable via env so dogfood can tune them without
 * a redeploy. Anything past STUCK_RUN_RUNNING_MS in `running` or past
 * STUCK_RUN_PAUSED_OVERDUE_MS past a missed `wake_at` is hard-failed with
 * `reason: 'stuck_watchdog'` so an operator can grep the audit log.
 */
const STUCK_RUN_RUNNING_MS = Number(process.env.STUCK_RUN_RUNNING_MS ?? 2 * 60 * 60 * 1000);
const STUCK_RUN_PAUSED_OVERDUE_MS = Number(
  process.env.STUCK_RUN_PAUSED_OVERDUE_MS ?? 60 * 60 * 1000,
);

export async function stuckRunWatchdog(deps: { eventlog: Eventlog; logger: Logger; now?: Date }): Promise<void> {
  const { logger, eventlog } = deps;
  const now = deps.now ?? new Date();
  const runningCutoff = new Date(now.getTime() - STUCK_RUN_RUNNING_MS);
  const pausedCutoff = new Date(now.getTime() - STUCK_RUN_PAUSED_OVERDUE_MS);

  // 1. Long-running runs (no progress, status still `running`).
  const stuckRunning = await withSystem((tx) =>
    tx.dailyRun.findMany({
      where: { status: 'running', startedAt: { lt: runningCutoff } },
      select: { id: true, organizationId: true, projectId: true, startedAt: true },
    }),
  );
  for (const r of stuckRunning) {
    await failStuck(r, 'running_too_long', { logger, eventlog, now });
  }

  // 2. Paused-on-rate-limit runs whose wake-up was missed (BullMQ delayed
  // job fired but the orchestrator didn't transition state). Pick the most
  // recent unresumed pause per run.
  const overduePauses = await withSystem((tx) =>
    tx.runPause.findMany({
      where: {
        kind: 'rate_limit',
        resumedAt: null,
        wakeAt: { not: null, lt: pausedCutoff },
      },
      include: {
        dailyRun: { select: { id: true, organizationId: true, projectId: true, status: true } },
      },
    }),
  );
  for (const p of overduePauses) {
    if (p.dailyRun.status !== 'paused_rate_limit') continue;
    await failStuck(
      {
        id: p.dailyRun.id,
        organizationId: p.dailyRun.organizationId,
        projectId: p.dailyRun.projectId,
        startedAt: p.pausedAt,
      },
      'paused_rate_limit_overdue',
      { logger, eventlog, now },
    );
  }
}

async function failStuck(
  run: { id: string; organizationId: string; projectId: string; startedAt: Date | null },
  detail: string,
  ctx: { eventlog: Eventlog; logger: Logger; now: Date },
): Promise<void> {
  try {
    await withTenant(run.organizationId, (tx) =>
      tx.dailyRun.update({
        where: { id: run.id },
        data: { status: 'failed', finishedAt: ctx.now },
      }),
    );
    await ctx.eventlog.emit({
      organizationId: run.organizationId,
      projectId: run.projectId,
      dailyRunId: run.id,
      type: 'RUN_FAILED',
      actor: { kind: 'system' },
      payload: { reason: 'stuck_watchdog', detail },
    });
    ctx.logger.warn(
      { runId: run.id, projectId: run.projectId, detail, startedAt: run.startedAt?.toISOString() },
      'stuck-run-watchdog: failed run',
    );
  } catch (err) {
    ctx.logger.error(
      { runId: run.id, err: (err as Error)?.message ?? String(err) },
      'stuck-run-watchdog: fail update threw',
    );
  }
}
