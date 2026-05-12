import type { Logger } from 'pino';
import { withSystem, withTenant } from '@mergecrew/db';
import { runEvalsForOrg } from '@mergecrew/eval-runner';

/**
 * Nightly eval auto-run tick (#303).
 *
 * Iterates every org with `evals_enabled = true` and `evals_last_ran_at`
 * older than `EVAL_CRON_MIN_INTERVAL_MS` (default 23h). Bumps the
 * timestamp BEFORE invoking the runner so a flaky tick can't
 * double-dispatch; on a failed run the next tick still picks it up
 * 23h later.
 *
 * The runner is invoked in-process — the eval-runner package's
 * library entry. That means worker-cron's process needs LLM
 * credentials available (via the org's stored providers); the call
 * goes through the same withTenant + decryptDevOnly path the runner's
 * production agent uses.
 */
export async function evalTick(deps: { logger: Logger; now?: Date }): Promise<void> {
  const logger = deps.logger;
  const now = deps.now ?? new Date();
  const minIntervalMs = Number(process.env.EVAL_CRON_MIN_INTERVAL_MS ?? 23 * 3600_000);

  const orgs = await withSystem((tx) =>
    tx.organization.findMany({
      where: { evalsEnabled: true, deletedAt: null },
      select: { id: true, slug: true, evalsLastRanAt: true },
    }),
  );

  for (const org of orgs) {
    const lastRan = org.evalsLastRanAt?.getTime() ?? 0;
    const due = now.getTime() - lastRan >= minIntervalMs;
    if (!due) continue;

    // Bump the timestamp BEFORE the run so two parallel ticks can't
    // both dispatch. The eval-runner records its own EvalRun row;
    // the timestamp here is just dedup state.
    try {
      await withTenant(org.id, (tx) =>
        tx.organization.update({
          where: { id: org.id },
          data: { evalsLastRanAt: new Date() },
        }),
      );
    } catch (err) {
      logger.warn(
        { orgId: org.id, err: (err as Error)?.message ?? String(err) },
        'eval-tick: failed to bump evals_last_ran_at; skipping',
      );
      continue;
    }

    try {
      const result = await runEvalsForOrg(
        { orgSlug: org.slug, source: 'cron' },
        (msg: string) => logger.info({ orgId: org.id }, `[eval] ${msg}`),
      );
      logger.info(
        {
          orgId: org.id,
          evalRunId: result.evalRunId,
          pass: result.pass,
          fail: result.fail,
          error: result.error,
          totalUsd: result.totalUsd,
        },
        'eval-tick: completed',
      );
    } catch (err) {
      // Best-effort: a single org's failure (e.g. missing providers,
      // missing profile) doesn't stop the loop. The next tick picks
      // up the next due org as scheduled.
      logger.warn(
        { orgId: org.id, err: (err as Error)?.message ?? String(err) },
        'eval-tick: run failed',
      );
    }
  }
}
