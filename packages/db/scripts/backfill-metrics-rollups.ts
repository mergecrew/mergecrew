/* eslint-disable no-console */
/**
 * Backfill `metrics_rollups` for the last N days (V2.af / #742).
 *
 * Walks hourly buckets from `--from` to `--to` (defaults: 30 days ago →
 * the start of the current hour), calling `computeMetricsRollups` for
 * each. Then walks daily buckets across the same range. UPSERTs make
 * the whole pass idempotent: re-running just overwrites.
 *
 * Usage:
 *   pnpm -F @mergecrew/db tsx scripts/backfill-metrics-rollups.ts
 *   pnpm -F @mergecrew/db tsx scripts/backfill-metrics-rollups.ts --days 7
 *   pnpm -F @mergecrew/db tsx scripts/backfill-metrics-rollups.ts --from 2026-04-01 --to 2026-04-08
 */
import { computeMetricsRollups, truncToDay, truncToHour } from '../src/index.js';

type Args = { from: Date; to: Date };

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  let from: Date | null = null;
  let to: Date | null = null;
  let days: number | null = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--days' && argv[i + 1]) {
      days = Number(argv[++i]);
    } else if (a === '--from' && argv[i + 1]) {
      from = new Date(argv[++i]);
    } else if (a === '--to' && argv[i + 1]) {
      to = new Date(argv[++i]);
    }
  }
  const now = new Date();
  const defaultDays = 30;
  const span = Number.isFinite(days) ? Number(days) : defaultDays;
  const fromDefault = new Date(now.getTime() - span * 24 * 60 * 60 * 1000);
  return {
    from: from ?? fromDefault,
    to: to ?? truncToHour(now),
  };
}

async function main(): Promise<void> {
  const { from, to } = parseArgs();
  const fromHour = truncToHour(from);
  const toHour = truncToHour(to);
  const fromDay = truncToDay(from);
  const toDay = truncToDay(to);

  console.log(
    `[backfill-metrics-rollups] hourly from ${fromHour.toISOString()} to ${toHour.toISOString()}`,
  );
  for (
    let b = fromHour.getTime();
    b < toHour.getTime();
    b += 60 * 60 * 1000
  ) {
    const start = new Date(b);
    const r = await computeMetricsRollups({ granularity: 'hour', bucketStart: start });
    if (r.orgRows > 0 || r.projectRows > 0) {
      console.log(
        `  ${start.toISOString()}  orgs=${r.orgRows}  projects=${r.projectRows}`,
      );
    }
  }

  console.log(
    `[backfill-metrics-rollups] daily from ${fromDay.toISOString()} to ${toDay.toISOString()}`,
  );
  for (
    let b = fromDay.getTime();
    b < toDay.getTime();
    b += 24 * 60 * 60 * 1000
  ) {
    const start = new Date(b);
    const r = await computeMetricsRollups({ granularity: 'day', bucketStart: start });
    if (r.orgRows > 0 || r.projectRows > 0) {
      console.log(
        `  ${start.toISOString()}  orgs=${r.orgRows}  projects=${r.projectRows}`,
      );
    }
  }

  console.log('[backfill-metrics-rollups] done');
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('[backfill-metrics-rollups] failed', err);
    process.exit(1);
  });
