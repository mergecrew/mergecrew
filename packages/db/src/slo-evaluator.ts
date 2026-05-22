import { getSystemPrisma } from './client.js';

/**
 * SLO evaluator (V2.af / #745).
 *
 * Given a project's SLO definitions, this helper reads recent
 * `metrics_rollups` rows for the project, computes the current numeric
 * value of each metric, and derives a state (`OK`, `AT_RISK`,
 * `BREACHING`, `INSUFFICIENT_DATA`).
 *
 * The helper is read-only — it does not mutate state. The worker-cron
 * `sloEvaluatorTick` pairs this with the last `slo.transitioned`
 * timeline event per SLO and emits a new one only on a state change.
 */

export type SloMetric =
  | 'stepPassRate'
  | 'runFailureRate'
  | 'p95StepMs'
  | 'dailyCostUsd';

export type SloComparator = 'gte' | 'lte';

export type SloState = 'OK' | 'AT_RISK' | 'BREACHING' | 'INSUFFICIENT_DATA';

export type SloDefinition = {
  id: string;
  organizationId: string;
  projectId: string;
  name: string;
  metric: SloMetric;
  comparator: SloComparator;
  /** Threshold value in the metric's natural unit. */
  threshold: number;
  windowHours: number;
};

export type SloEvaluationResult = {
  sloId: string;
  state: SloState;
  /** The metric value computed over the window. `null` for INSUFFICIENT_DATA. */
  current: number | null;
  /** ISO timestamp of the window start used in this evaluation. */
  windowStart: string;
  /** ISO timestamp of the window end (typically now). */
  windowEnd: string;
};

/** Margin around the threshold (10%) that flips OK → AT_RISK. */
const RISK_BAND = 0.1;

/**
 * Evaluate one SLO. Returns the current numeric value + a state
 * classification. Uses hourly rollups when window ≤ 24h, daily
 * rollups otherwise (rounded up to whole days).
 */
export async function evaluateSlo(
  slo: SloDefinition,
  opts?: { now?: Date },
): Promise<SloEvaluationResult> {
  const now = opts?.now ?? new Date();
  const useHourly = slo.windowHours <= 24;
  const granularity = useHourly ? 'hour' : 'day';
  const windowMs = slo.windowHours * 60 * 60 * 1000;
  const start = new Date(now.getTime() - windowMs);

  const prisma = getSystemPrisma();
  const rollups = await prisma.metricsRollup.findMany({
    where: {
      organizationId: slo.organizationId,
      projectId: slo.projectId,
      granularity,
      bucket: { gte: start, lte: now },
    },
  });

  const current = aggregateMetric(slo.metric, rollups);
  const state = classify(slo, current);

  return {
    sloId: slo.id,
    state,
    current,
    windowStart: start.toISOString(),
    windowEnd: now.toISOString(),
  };
}

type RollupRow = {
  stepsRun: number;
  stepsPassed: number;
  runsStarted: number;
  runsFailed: number;
  p95StepMs: number;
  costUsdCents: bigint | number;
  bucket: Date;
};

function aggregateMetric(metric: SloMetric, rollups: RollupRow[]): number | null {
  if (rollups.length === 0) return null;
  switch (metric) {
    case 'stepPassRate': {
      const sumRun = rollups.reduce((s, r) => s + r.stepsRun, 0);
      const sumPassed = rollups.reduce((s, r) => s + r.stepsPassed, 0);
      if (sumRun === 0) return null;
      return (sumPassed / sumRun) * 100;
    }
    case 'runFailureRate': {
      const sumStarted = rollups.reduce((s, r) => s + r.runsStarted, 0);
      const sumFailed = rollups.reduce((s, r) => s + r.runsFailed, 0);
      if (sumStarted === 0) return null;
      return (sumFailed / sumStarted) * 100;
    }
    case 'p95StepMs': {
      // Window-average of the per-bucket p95 — not perfect (a true
      // window p95 would re-percentile the raw step set), but stable
      // and cheap. Drops buckets with no step activity to avoid
      // pulling the average down with zeroes.
      const active = rollups.filter((r) => r.stepsRun > 0);
      if (active.length === 0) return null;
      return active.reduce((s, r) => s + r.p95StepMs, 0) / active.length;
    }
    case 'dailyCostUsd': {
      // Average daily USD over the window. `rollups.length` is the
      // count of buckets present at the chosen granularity; convert to
      // days for normalization. Hour granularity: divide by 24; day
      // granularity: divide by the number of day buckets directly.
      const sumCents = rollups.reduce(
        (s, r) => s + Number(r.costUsdCents),
        0,
      );
      const firstBucket = rollups[0]!.bucket;
      const lastBucket = rollups[rollups.length - 1]!.bucket;
      const isHourly = lastBucket.getTime() - firstBucket.getTime() < 26 * 60 * 60 * 1000 && rollups.length <= 24;
      const days = isHourly
        ? Math.max(1, rollups.length / 24)
        : Math.max(1, rollups.length);
      return sumCents / 100 / days;
    }
  }
}

function classify(slo: SloDefinition, current: number | null): SloState {
  if (current == null) return 'INSUFFICIENT_DATA';
  const t = slo.threshold;
  const band = Math.abs(t) * RISK_BAND;
  if (slo.comparator === 'gte') {
    if (current < t) return 'BREACHING';
    if (current < t + band) return 'AT_RISK';
    return 'OK';
  } else {
    // lte
    if (current > t) return 'BREACHING';
    if (current > t - band) return 'AT_RISK';
    return 'OK';
  }
}
