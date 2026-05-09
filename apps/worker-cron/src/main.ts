import { Queue } from 'bullmq';
import IORedis from 'ioredis';
import pino from 'pino';
import { parseExpression } from 'cron-parser';
import { withSystem, withTenant } from '@mergecrew/db';
import { digestTick } from './digest-tick.js';
import { isSkipped, dateInTz } from './skip.js';

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

const TICK_MS = Number(process.env.WORKER_CRON_TICK_MS ?? 60_000);

async function tick() {
  const schedules = await withSystem((tx) =>
    tx.schedule.findMany({ where: { enabled: true } }),
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
  await conn.quit();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

logger.info({ tickMs: TICK_MS }, 'worker-cron started');
setInterval(() => {
  tick().catch((err) => logger.error({ err: String(err?.message ?? err) }, 'tick failed'));
  digestTick({ digestQueue, logger }).catch((err) =>
    logger.error({ err: String(err?.message ?? err) }, 'digest-tick failed'),
  );
}, TICK_MS);
// First tick at startup
tick().catch((err) => logger.error({ err: String(err?.message ?? err) }, 'initial tick failed'));
digestTick({ digestQueue, logger }).catch((err) =>
  logger.error({ err: String(err?.message ?? err) }, 'initial digest-tick failed'),
);
