import type { Logger } from 'pino';
import { computeMetricsRollups, truncToHour, truncToDay } from '@mergecrew/db';

/**
 * Worker tick that rolls up telemetry into the `metrics_rollups` table
 * (V2.af / #742). Computed at two granularities:
 *
 *   - `hour`: the previous fully-elapsed UTC hour, run on every tick
 *     once that hour has closed. The UPSERT is idempotent, so multiple
 *     tick intervals in the same hour are no-ops.
 *   - `day`:  the previous calendar UTC day, run once a day after 00:00
 *     UTC. Same idempotency story.
 *
 * In-process state tracks the last bucket each granularity processed so
 * the tick can skip cheaply between firings. Process restarts re-run
 * the relevant bucket once, which is harmless.
 */

let lastHourlyBucket: number | null = null;
let lastDailyBucket: number | null = null;

export type MetricsRollupTickDeps = {
  logger: Logger;
  /** Override the clock for tests. */
  now?: Date;
};

export async function metricsRollupTick(deps: MetricsRollupTickDeps): Promise<void> {
  const { logger } = deps;
  const now = deps.now ?? new Date();

  // The bucket we want is the one that *closed* before `now`. For the
  // hour grain that's `truncToHour(now) - 1h`; for the day grain it's
  // `truncToDay(now) - 1d`. Anything else either hasn't finished yet
  // (would produce a partial bucket) or has already been processed.
  const hourBucket = new Date(truncToHour(now).getTime() - 60 * 60 * 1000);
  const dayBucket = new Date(truncToDay(now).getTime() - 24 * 60 * 60 * 1000);

  if (hourBucket.getTime() !== lastHourlyBucket) {
    try {
      const r = await computeMetricsRollups({
        granularity: 'hour',
        bucketStart: hourBucket,
      });
      lastHourlyBucket = hourBucket.getTime();
      logger.info(
        {
          bucket: r.bucketStart.toISOString(),
          orgRows: r.orgRows,
          projectRows: r.projectRows,
        },
        'metrics.rollup_hourly',
      );
    } catch (err) {
      logger.error(
        { err: (err as Error)?.message ?? String(err), bucket: hourBucket.toISOString() },
        'metrics.rollup_hourly_failed',
      );
    }
  }

  if (dayBucket.getTime() !== lastDailyBucket) {
    try {
      const r = await computeMetricsRollups({
        granularity: 'day',
        bucketStart: dayBucket,
      });
      lastDailyBucket = dayBucket.getTime();
      logger.info(
        {
          bucket: r.bucketStart.toISOString(),
          orgRows: r.orgRows,
          projectRows: r.projectRows,
        },
        'metrics.rollup_daily',
      );
    } catch (err) {
      logger.error(
        { err: (err as Error)?.message ?? String(err), bucket: dayBucket.toISOString() },
        'metrics.rollup_daily_failed',
      );
    }
  }
}

/** Reset cached state. Tests only. */
export function _resetMetricsRollupTickState(): void {
  lastHourlyBucket = null;
  lastDailyBucket = null;
}
