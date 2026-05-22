import { Prisma } from '@prisma/client';
import { getSystemPrisma } from './client.js';

/**
 * Pre-aggregated telemetry rollups (V2.af / #742).
 *
 * The rollup table powers the org + project metrics pages, the SLO
 * evaluator, and project health badges without those surfaces having
 * to scan raw `daily_runs` / `agent_steps` / `llm_invocations` per
 * request.
 *
 * Two granularities — `hour` and `day` — keyed on
 * `(organization_id, project_id?, granularity, bucket)`. The
 * project_id-null branch is the org-wide rollup; the project-scoped
 * branch is the per-project rollup for the same window.
 *
 * `computeMetricsRollups()` is the single chokepoint for both the
 * worker-cron tick (one bucket at a time) and the backfill script
 * (many buckets). Raw SQL lives here per the chokepoint rule (#582);
 * the worker calls this helper rather than running SQL itself.
 */

export type MetricsRollupGranularity = 'hour' | 'day';

export type ComputeMetricsRollupsOptions = {
  /** UTC instant at the start of the bucket (must already be truncated). */
  bucketStart: Date;
  granularity: MetricsRollupGranularity;
};

export type ComputeMetricsRollupsResult = {
  bucketStart: Date;
  bucketEnd: Date;
  granularity: MetricsRollupGranularity;
  orgRows: number;
  projectRows: number;
};

/** Truncate a Date to the start of its UTC hour. */
export function truncToHour(d: Date): Date {
  const t = new Date(d.getTime());
  t.setUTCMinutes(0, 0, 0);
  return t;
}

/** Truncate a Date to the start of its UTC day. */
export function truncToDay(d: Date): Date {
  const t = new Date(d.getTime());
  t.setUTCHours(0, 0, 0, 0);
  return t;
}

function bucketEnd(start: Date, granularity: MetricsRollupGranularity): Date {
  const ms = granularity === 'hour' ? 60 * 60 * 1000 : 24 * 60 * 60 * 1000;
  return new Date(start.getTime() + ms);
}

/**
 * Compute and UPSERT rollups for a single (granularity, bucketStart)
 * window across every org with activity in the window. Idempotent:
 * re-running on the same bucket overwrites with the latest aggregates.
 *
 * Returns row counts for observability. The org-wide row count usually
 * equals the number of distinct orgs that touched the platform in the
 * window; the project-row count usually exceeds it.
 */
export async function computeMetricsRollups(
  opts: ComputeMetricsRollupsOptions,
): Promise<ComputeMetricsRollupsResult> {
  const start = opts.bucketStart;
  const end = bucketEnd(start, opts.granularity);
  const grain = opts.granularity;
  const prisma = getSystemPrisma();

  // ────────────────────────────────────────────────────────────────────
  // Project-scoped rollups. One CTE per source (runs, steps, llm) keyed
  // on (organization_id, project_id); FULL OUTER JOIN unions the keys
  // so a project that had llm activity but no completed steps still
  // gets a row, and vice versa.
  // ────────────────────────────────────────────────────────────────────
  const projectInsert = Prisma.sql`
    with
    runs as (
      select
        dr.organization_id,
        dr.project_id,
        count(*) filter (where dr.started_at >= ${start} and dr.started_at < ${end})       as runs_started,
        count(*) filter (where dr.finished_at >= ${start} and dr.finished_at < ${end}
                              and dr.status = 'completed')                                  as runs_completed,
        count(*) filter (where dr.finished_at >= ${start} and dr.finished_at < ${end}
                              and dr.status = 'failed')                                     as runs_failed
      from daily_runs dr
      where (dr.started_at >= ${start} and dr.started_at < ${end})
         or (dr.finished_at >= ${start} and dr.finished_at < ${end})
      group by dr.organization_id, dr.project_id
    ),
    steps as (
      select
        s.organization_id,
        dr.project_id,
        count(*)                                                                            as steps_run,
        count(*) filter (where s.status = 'completed')                                      as steps_passed,
        coalesce(percentile_cont(0.5) within group (
          order by extract(epoch from (s.finished_at - s.started_at)) * 1000.0
        ), 0)                                                                               as p50_ms,
        coalesce(percentile_cont(0.95) within group (
          order by extract(epoch from (s.finished_at - s.started_at)) * 1000.0
        ), 0)                                                                               as p95_ms
      from agent_steps s
      join workflow_runs wr on wr.id = s.workflow_run_id
      join daily_runs dr    on dr.id = wr.daily_run_id
      where s.started_at  is not null
        and s.finished_at is not null
        and s.finished_at >= ${start}
        and s.finished_at <  ${end}
      group by s.organization_id, dr.project_id
    ),
    llm as (
      select
        li.organization_id,
        li.project_id,
        sum(li.input_tokens)::bigint                                                        as tokens_in,
        sum(li.output_tokens)::bigint                                                       as tokens_out,
        sum(round(li.usd_estimate * 100))::bigint                                           as cost_cents
      from llm_invocations li
      where li.occurred_at >= ${start}
        and li.occurred_at <  ${end}
      group by li.organization_id, li.project_id
    ),
    keys as (
      select organization_id, project_id from runs
      union
      select organization_id, project_id from steps
      union
      select organization_id, project_id from llm
    )
    insert into metrics_rollups (
      organization_id, project_id, granularity, bucket,
      runs_started, runs_completed, runs_failed,
      steps_run, steps_passed, p50_step_ms, p95_step_ms,
      llm_tokens_in, llm_tokens_out, cost_usd_cents,
      computed_at
    )
    select
      k.organization_id,
      k.project_id,
      ${grain},
      ${start},
      coalesce(r.runs_started,   0)::int,
      coalesce(r.runs_completed, 0)::int,
      coalesce(r.runs_failed,    0)::int,
      coalesce(s.steps_run,      0)::int,
      coalesce(s.steps_passed,   0)::int,
      coalesce(s.p50_ms,         0)::int,
      coalesce(s.p95_ms,         0)::int,
      coalesce(l.tokens_in,      0)::bigint,
      coalesce(l.tokens_out,     0)::bigint,
      coalesce(l.cost_cents,     0)::bigint,
      now()
    from keys k
    left join runs  r using (organization_id, project_id)
    left join steps s using (organization_id, project_id)
    left join llm   l using (organization_id, project_id)
    where k.project_id is not null
    on conflict (organization_id, project_id, granularity, bucket)
      where project_id is not null
      do update set
        runs_started   = excluded.runs_started,
        runs_completed = excluded.runs_completed,
        runs_failed    = excluded.runs_failed,
        steps_run      = excluded.steps_run,
        steps_passed   = excluded.steps_passed,
        p50_step_ms    = excluded.p50_step_ms,
        p95_step_ms    = excluded.p95_step_ms,
        llm_tokens_in  = excluded.llm_tokens_in,
        llm_tokens_out = excluded.llm_tokens_out,
        cost_usd_cents = excluded.cost_usd_cents,
        computed_at    = now()
  `;

  // Org-wide rollups: same CTEs but grouped by organization_id only.
  // Re-running the aggregation rather than summing project rows so the
  // p50/p95 percentiles are computed against the org's whole step set,
  // not a mean-of-means.
  const orgInsert = Prisma.sql`
    with
    runs as (
      select
        dr.organization_id,
        count(*) filter (where dr.started_at >= ${start} and dr.started_at < ${end})       as runs_started,
        count(*) filter (where dr.finished_at >= ${start} and dr.finished_at < ${end}
                              and dr.status = 'completed')                                  as runs_completed,
        count(*) filter (where dr.finished_at >= ${start} and dr.finished_at < ${end}
                              and dr.status = 'failed')                                     as runs_failed
      from daily_runs dr
      where (dr.started_at >= ${start} and dr.started_at < ${end})
         or (dr.finished_at >= ${start} and dr.finished_at < ${end})
      group by dr.organization_id
    ),
    steps as (
      select
        s.organization_id,
        count(*)                                                                            as steps_run,
        count(*) filter (where s.status = 'completed')                                      as steps_passed,
        coalesce(percentile_cont(0.5) within group (
          order by extract(epoch from (s.finished_at - s.started_at)) * 1000.0
        ), 0)                                                                               as p50_ms,
        coalesce(percentile_cont(0.95) within group (
          order by extract(epoch from (s.finished_at - s.started_at)) * 1000.0
        ), 0)                                                                               as p95_ms
      from agent_steps s
      where s.started_at  is not null
        and s.finished_at is not null
        and s.finished_at >= ${start}
        and s.finished_at <  ${end}
      group by s.organization_id
    ),
    llm as (
      select
        li.organization_id,
        sum(li.input_tokens)::bigint                                                        as tokens_in,
        sum(li.output_tokens)::bigint                                                       as tokens_out,
        sum(round(li.usd_estimate * 100))::bigint                                           as cost_cents
      from llm_invocations li
      where li.occurred_at >= ${start}
        and li.occurred_at <  ${end}
      group by li.organization_id
    ),
    keys as (
      select organization_id from runs
      union
      select organization_id from steps
      union
      select organization_id from llm
    )
    insert into metrics_rollups (
      organization_id, project_id, granularity, bucket,
      runs_started, runs_completed, runs_failed,
      steps_run, steps_passed, p50_step_ms, p95_step_ms,
      llm_tokens_in, llm_tokens_out, cost_usd_cents,
      computed_at
    )
    select
      k.organization_id,
      null::uuid,
      ${grain},
      ${start},
      coalesce(r.runs_started,   0)::int,
      coalesce(r.runs_completed, 0)::int,
      coalesce(r.runs_failed,    0)::int,
      coalesce(s.steps_run,      0)::int,
      coalesce(s.steps_passed,   0)::int,
      coalesce(s.p50_ms,         0)::int,
      coalesce(s.p95_ms,         0)::int,
      coalesce(l.tokens_in,      0)::bigint,
      coalesce(l.tokens_out,     0)::bigint,
      coalesce(l.cost_cents,     0)::bigint,
      now()
    from keys k
    left join runs  r using (organization_id)
    left join steps s using (organization_id)
    left join llm   l using (organization_id)
    on conflict (organization_id, granularity, bucket)
      where project_id is null
      do update set
        runs_started   = excluded.runs_started,
        runs_completed = excluded.runs_completed,
        runs_failed    = excluded.runs_failed,
        steps_run      = excluded.steps_run,
        steps_passed   = excluded.steps_passed,
        p50_step_ms    = excluded.p50_step_ms,
        p95_step_ms    = excluded.p95_step_ms,
        llm_tokens_in  = excluded.llm_tokens_in,
        llm_tokens_out = excluded.llm_tokens_out,
        cost_usd_cents = excluded.cost_usd_cents,
        computed_at    = now()
  `;

  const projectRows = await prisma.$executeRaw(projectInsert);
  const orgRows = await prisma.$executeRaw(orgInsert);

  return {
    bucketStart: start,
    bucketEnd: end,
    granularity: grain,
    orgRows,
    projectRows,
  };
}
