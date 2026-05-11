import { Queue } from 'bullmq';
import IORedis from 'ioredis';
import pino from 'pino';
import { parseExpression } from 'cron-parser';
import { withSystem, withTenant } from '@mergecrew/db';
import { Eventlog, RedisPubSub, fanoutToBullmq } from '@mergecrew/eventlog';
import { digestTick } from './digest-tick.js';
import { isSkipped, dateInTz } from './skip.js';
import { auditRetentionTick } from './audit-retention-tick.js';
import { stuckRunWatchdog } from './stuck-run-watchdog.js';

const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  base: { service: 'worker-cron' },
  ...(process.env.NODE_ENV !== 'production'
    ? { transport: { target: 'pino-pretty', options: { colorize: true } } }
    : {}),
});

const url = process.env.REDIS_URL ?? 'redis://localhost:6379';
const conn = new IORedis(url, { maxRetriesPerRequest: null });
const queue = new Queue('run.due', { connection: conn });
const digestQueue = new Queue('digest.dispatch', { connection: conn });
const fanoutQueue = new Queue('webhook.fanout', { connection: conn });
const pubsub = new RedisPubSub(url);
const eventlog = new Eventlog(pubsub, fanoutToBullmq(fanoutQueue));

const TICK_MS = Number(process.env.WORKER_CRON_TICK_MS ?? 60_000);

async function tick() {
  // Pull the project's connectedRepo + deployTargets alongside the
  // schedule so we can short-circuit paused projects (#229) — onboarding
  // can finish without a deploy target, and the project stays paused
  // until the operator wires both up. We still keep `lastFiredAt` ticking
  // for skipDates, but never enqueue for a paused project.
  const schedules = await withSystem((tx) =>
    tx.schedule.findMany({
      where: { enabled: true },
      include: {
        project: {
          select: {
            connectedRepo: { select: { id: true } },
            deployTargets: { select: { kind: true } },
          },
        },
      },
    }),
  );
  const now = new Date();
  for (const s of schedules) {
    const last = s.lastFiredAt ?? new Date(now.getTime() - 60 * 86_400_000);
    let due = false;
    try {
      const it = parseExpression(s.cron, { tz: s.timezone, currentDate: last });
      const next = it.next().toDate();
      if (next <= now) due = true;
    } catch (e) {
      logger.warn({ scheduleId: s.id, err: String(e) }, 'invalid cron');
      continue;
    }
    if (!due) continue;

    const hasRepo = s.project?.connectedRepo != null;
    const hasDevTarget = (s.project?.deployTargets ?? []).some((d) => d.kind === 'dev');
    if (!hasRepo || !hasDevTarget) {
      // Paused project: bump lastFiredAt so we don't recompute "due" on
      // every tick, and log once so an operator wondering "why didn't my
      // daily run fire" has a breadcrumb in the worker-cron output.
      await withTenant(s.organizationId, (tx) =>
        tx.schedule.update({ where: { id: s.id }, data: { lastFiredAt: now } }),
      );
      logger.info(
        { projectId: s.projectId, hasRepo, hasDevTarget },
        'skipping run.due: project paused (missing repo or dev deploy target)',
      );
      continue;
    }

    if (isSkipped(s.skipDates ?? [], s.timezone, now)) {
      // Bump lastFiredAt so the cron iterator doesn't think we're permanently
      // overdue — next firing will be tomorrow's normal cron occurrence.
      await withTenant(s.organizationId, (tx) =>
        tx.schedule.update({ where: { id: s.id }, data: { lastFiredAt: now } }),
      );
      logger.info(
        { projectId: s.projectId, today: dateInTz(now, s.timezone) },
        'skipping run.due: today is in schedule.skipDates',
      );
      continue;
    }

    await queue.add(
      'run.due',
      { organizationId: s.organizationId, projectId: s.projectId, manual: false },
      { removeOnComplete: 1000 },
    );
    await withTenant(s.organizationId, (tx) =>
      tx.schedule.update({
        where: { id: s.id },
        data: { lastFiredAt: now },
      }),
    );
    logger.info({ projectId: s.projectId }, 'enqueued run.due');
  }
}

async function shutdown() {
  await queue.close();
  await digestQueue.close();
  await fanoutQueue.close();
  await pubsub.close();
  await conn.quit();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// Audit-log retention runs once per UTC day. The TICK_MS loop just checks
// the marker; the actual prune is gated. In-process state — restarts
// re-run, which is harmless because deleteMany is idempotent.
let lastRetentionDay: string | null = null;
function maybeRunRetention(): void {
  const today = new Date().toISOString().slice(0, 10);
  if (lastRetentionDay === today) return;
  lastRetentionDay = today;
  auditRetentionTick({ logger }).catch((err) =>
    logger.error({ err: String(err?.message ?? err) }, 'audit-retention-tick failed'),
  );
}

logger.info({ tickMs: TICK_MS }, 'worker-cron started');
setInterval(() => {
  tick().catch((err) => logger.error({ err: String(err?.message ?? err) }, 'tick failed'));
  digestTick({ digestQueue, logger }).catch((err) =>
    logger.error({ err: String(err?.message ?? err) }, 'digest-tick failed'),
  );
  stuckRunWatchdog({ eventlog, logger }).catch((err) =>
    logger.error({ err: String(err?.message ?? err) }, 'stuck-run-watchdog failed'),
  );
  maybeRunRetention();
}, TICK_MS);
// First tick at startup
tick().catch((err) => logger.error({ err: String(err?.message ?? err) }, 'initial tick failed'));
digestTick({ digestQueue, logger }).catch((err) =>
  logger.error({ err: String(err?.message ?? err) }, 'initial digest-tick failed'),
);
stuckRunWatchdog({ eventlog, logger }).catch((err) =>
  logger.error({ err: String(err?.message ?? err) }, 'initial stuck-run-watchdog failed'),
);
maybeRunRetention();
