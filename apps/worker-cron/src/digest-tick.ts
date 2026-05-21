import type { Queue } from 'bullmq';
import type { Logger } from 'pino';
import { parseExpression } from 'cron-parser';
import { withSystem, withTenant } from '@mergecrew/db';

/**
 * Returns today's end-of-working-hours instant in the given tz, computed
 * as the most recent occurrence of `HH:MM daily` cron at-or-before now.
 * If now hasn't reached today's end-of-day yet, this returns yesterday's.
 */
export function lastEndOfDay(tz: string, hhmm: string, now: Date): Date | null {
  const [hStr, mStr] = hhmm.split(':');
  const h = Number(hStr);
  const m = Number(mStr);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
  try {
    const it = parseExpression(`${m} ${h} * * *`, { tz, currentDate: now });
    return it.prev().toDate();
  } catch {
    return null;
  }
}

/**
 * One pass over all live projects: enqueue a `digest.dispatch` job per
 * project whose end-of-working-hours has passed and whose lastDigestAt
 * is older than that instant. lastDigestAt is bumped before the job is
 * acked so a flaky tick can't double-send.
 */
export async function digestTick(deps: {
  digestQueue: Queue;
  logger: Logger;
  now?: Date;
}): Promise<void> {
  const { digestQueue, logger } = deps;
  const now = deps.now ?? new Date();

  // Skip projects that should never send a digest at the source rather
  // than at the dispatch fan-out: demo projects (seeded read-only
  // samples that can never produce real changesets — #635), and any
  // project where ops has hit the kill switch (project- or org-scope,
  // per #625). Doing it here also keeps `lastDigestAt` from advancing
  // on a skipped project, so resuming a paused project immediately
  // delivers the next eod's digest instead of having to wait an extra
  // tick.
  const projects = await withSystem((tx) =>
    tx.project.findMany({
      where: {
        archivedAt: null,
        deletedAt: null,
        demo: false,
        runsPausedAt: null,
        organization: { runsPausedAt: null },
      },
      select: {
        id: true,
        organizationId: true,
        slug: true,
        lastDigestAt: true,
        organization: {
          select: { timezone: true, workingHoursEnd: true },
        },
      },
    }),
  );

  for (const p of projects) {
    const tz = p.organization.timezone;
    const eod = lastEndOfDay(tz, p.organization.workingHoursEnd, now);
    if (!eod) {
      logger.warn(
        { projectId: p.id, tz, workingHoursEnd: p.organization.workingHoursEnd },
        'digest-tick: invalid tz/working-hours; skipping',
      );
      continue;
    }
    if (eod > now) continue; // not yet today
    if (p.lastDigestAt && p.lastDigestAt >= eod) continue; // already sent for this eod

    await withTenant(p.organizationId, (tx) =>
      tx.project.update({
        where: { id: p.id },
        data: { lastDigestAt: now },
      }),
    );

    await digestQueue.add(
      'digest.dispatch',
      {
        organizationId: p.organizationId,
        projectId: p.id,
        eod: eod.toISOString(),
      },
      { removeOnComplete: 1000, attempts: 3, backoff: { type: 'exponential', delay: 5_000 } },
    );

    logger.info({ projectId: p.id, eod: eod.toISOString() }, 'enqueued digest.dispatch');
  }
}
