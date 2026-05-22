import type { Logger } from 'pino';
import type { Eventlog } from '@mergecrew/eventlog';
import { evaluateSlo, withSystem, type SloMetric, type SloState } from '@mergecrew/db';

/**
 * SLO evaluator tick (V2.af / #745).
 *
 * Every TICK_MS, walks every enabled `project_slos` row, evaluates the
 * SLO against the latest `metrics_rollups`, and emits a TimelineEvent
 * of type `SLO_BREACHING`, `SLO_AT_RISK`, or `SLO_RECOVERED` when the
 * computed state crosses a boundary vs. the last known state.
 *
 * Last-known state is held in process memory keyed by sloId. On a fresh
 * process the first tick surfaces the current state of every active SLO
 * — useful after a restart, since operators can see the state on the
 * timeline without waiting for the next transition. Subsequent ticks
 * only emit on actual change.
 */

const lastStateBySloId = new Map<string, SloState>();
let lastTickAt = 0;

/** Minimum seconds between full evaluation passes. */
const MIN_INTERVAL_MS = 5 * 60 * 1000;

export type SloEvaluatorTickDeps = {
  eventlog: Eventlog;
  logger: Logger;
  now?: Date;
};

export async function sloEvaluatorTick(deps: SloEvaluatorTickDeps): Promise<void> {
  const { eventlog, logger } = deps;
  const now = deps.now ?? new Date();
  if (now.getTime() - lastTickAt < MIN_INTERVAL_MS) return;
  lastTickAt = now.getTime();

  const slos = await withSystem((tx) =>
    tx.projectSlo.findMany({
      where: { enabled: true },
      orderBy: { createdAt: 'asc' },
    }),
  );

  for (const s of slos) {
    let result;
    try {
      result = await evaluateSlo(
        {
          id: s.id,
          organizationId: s.organizationId,
          projectId: s.projectId,
          name: s.name,
          metric: s.metric as SloMetric,
          comparator: s.comparator as 'gte' | 'lte',
          threshold: Number(s.threshold),
          windowHours: s.windowHours,
        },
        { now },
      );
    } catch (err) {
      logger.warn(
        { sloId: s.id, err: (err as Error)?.message ?? String(err) },
        'slo.evaluate_failed',
      );
      continue;
    }

    const prior = lastStateBySloId.get(s.id) ?? null;
    if (prior === result.state) continue;

    // Skip the cosmetic transition from INSUFFICIENT_DATA → anything on
    // process startup; the previous state is just absent, not literally
    // INSUFFICIENT_DATA. Map prior=null to the current state so the
    // first surfaced transition is the next genuine change.
    lastStateBySloId.set(s.id, result.state);
    if (prior == null && result.state === 'INSUFFICIENT_DATA') continue;
    if (prior == null && result.state === 'OK') continue;

    const eventType = pickEventType(result.state);
    if (!eventType) continue;

    try {
      await eventlog.emit({
        organizationId: s.organizationId,
        projectId: s.projectId,
        type: eventType,
        actor: { kind: 'system' },
        payload: {
          sloId: s.id,
          name: s.name,
          metric: s.metric,
          comparator: s.comparator,
          threshold: Number(s.threshold),
          windowHours: s.windowHours,
          state: result.state,
          previousState: prior,
          current: result.current,
        },
      });
      logger.info(
        {
          sloId: s.id,
          projectId: s.projectId,
          prior,
          state: result.state,
          current: result.current,
        },
        'slo.transitioned',
      );
    } catch (err) {
      logger.error(
        { sloId: s.id, err: (err as Error)?.message ?? String(err) },
        'slo.emit_failed',
      );
    }
  }
}

function pickEventType(
  state: SloState,
): 'SLO_BREACHING' | 'SLO_AT_RISK' | 'SLO_RECOVERED' | null {
  switch (state) {
    case 'BREACHING':
      return 'SLO_BREACHING';
    case 'AT_RISK':
      return 'SLO_AT_RISK';
    case 'OK':
      return 'SLO_RECOVERED';
    case 'INSUFFICIENT_DATA':
      return null;
  }
}

/** Reset cached state. Tests only. */
export function _resetSloEvaluatorTickState(): void {
  lastStateBySloId.clear();
  lastTickAt = 0;
}
