/**
 * Daily-digest anomaly detectors (#288, #304). Scans the project's
 * state over the digest window (one UTC day ending at `eod`) and
 * surfaces six categories of "you probably want to look at this":
 *
 *   1. cost_spike       — today's LLM spend > 2× trailing-7-day daily avg
 *   2. blocked_changeset — blast-radius gate rejection (#285)
 *   3. risk_gate_hit    — risk-score gate routed a changeset to inbox (#286)
 *   4. rollback         — admin clicked rollback on a merged changeset (#287)
 *   5. file_spike       — a single changeset touched > 2× the trailing-30-day median
 *   6. eval_regression  — nightly eval pass-rate dropped > 10% below the
 *                         trailing-7-day median (#304)
 *
 * Each detector is independent and best-effort; if a query fails we
 * just skip that kind rather than fail the whole digest.
 */

import { withTenant } from '@mergecrew/db';
import type { DigestAnomaly } from '@mergecrew/adapters-comms';

interface Args {
  organizationId: string;
  projectId: string;
  orgSlug: string;
  projectSlug: string;
  eod: Date;
  webBaseUrl: string;
}

const COST_SPIKE_MULTIPLIER = 2;
const FILE_SPIKE_MULTIPLIER = 2;
const EVAL_REGRESSION_DROP_PCT = 10;
const EVAL_REGRESSION_MIN_HISTORY = 5;

export async function collectDigestAnomalies(args: Args): Promise<DigestAnomaly[]> {
  const { organizationId, projectId, orgSlug, projectSlug, eod, webBaseUrl } = args;
  const startOfWindow = startOfUtcDay(eod);
  const endOfWindow = new Date(startOfWindow.getTime() + 24 * 3600_000);
  const trailing7Start = new Date(startOfWindow.getTime() - 7 * 24 * 3600_000);
  const trailing30Start = new Date(startOfWindow.getTime() - 30 * 24 * 3600_000);

  const anomalies: DigestAnomaly[] = [];
  const projectBase = `${webBaseUrl}/orgs/${orgSlug}/projects/${projectSlug}`;
  const csUrl = (id: string) => `${projectBase}/changesets/${id}`;

  // 1. Cost spike — compare today's LLM spend vs trailing-7-day daily avg.
  try {
    const [todaySum, trailingSum] = await Promise.all([
      withTenant(organizationId, (tx) =>
        tx.llmInvocation.aggregate({
          where: {
            organizationId,
            projectId,
            occurredAt: { gte: startOfWindow, lt: endOfWindow },
          },
          _sum: { usdEstimate: true },
        }),
      ),
      withTenant(organizationId, (tx) =>
        tx.llmInvocation.aggregate({
          where: {
            organizationId,
            projectId,
            occurredAt: { gte: trailing7Start, lt: startOfWindow },
          },
          _sum: { usdEstimate: true },
        }),
      ),
    ]);
    const todayUsd = Number(todaySum._sum.usdEstimate ?? 0);
    const avgUsd = Number(trailingSum._sum.usdEstimate ?? 0) / 7;
    if (avgUsd > 0 && todayUsd > avgUsd * COST_SPIKE_MULTIPLIER) {
      anomalies.push({
        kind: 'cost_spike',
        todayUsd,
        avgUsd,
        multiplier: todayUsd / avgUsd,
        link: `${webBaseUrl}/orgs/${orgSlug}/costs`,
      });
    }
  } catch {
    /* skip */
  }

  // 2. Blocked changesets — blast-radius rejections in the window.
  try {
    const blocked = await withTenant(organizationId, (tx) =>
      tx.changeset.findMany({
        where: {
          projectId,
          status: 'blocked',
          updatedAt: { gte: startOfWindow, lt: endOfWindow },
        },
        select: { id: true, title: true, blockedReason: true },
      }),
    );
    for (const cs of blocked) {
      const reason =
        (cs.blockedReason as { kind?: string } | null)?.kind ?? 'unknown';
      anomalies.push({
        kind: 'blocked_changeset',
        changesetId: cs.id,
        title: cs.title,
        reason,
        link: csUrl(cs.id),
      });
    }
  } catch {
    /* skip */
  }

  // 3. Risk-gate hits — ApprovalRequest rows with reason=risk_score_high
  //    created in the window.
  try {
    const gated = await withTenant(organizationId, (tx) =>
      tx.approvalRequest.findMany({
        where: {
          projectId,
          reason: 'risk_score_high',
          createdAt: { gte: startOfWindow, lt: endOfWindow },
        },
        include: { changeset: { select: { id: true, title: true } } },
      }),
    );
    for (const ar of gated) {
      const d = ar.details as {
        score?: number;
        threshold?: number;
      } | null;
      anomalies.push({
        kind: 'risk_gate_hit',
        changesetId: ar.changeset?.id ?? ar.changesetId ?? 'unknown',
        title: ar.changeset?.title ?? 'unknown changeset',
        score: Number(d?.score ?? 0),
        threshold: Number(d?.threshold ?? 0),
        link: ar.changeset?.id ? csUrl(ar.changeset.id) : projectBase,
      });
    }
  } catch {
    /* skip */
  }

  // 4. Rollback events — changesets with status=rolled_back updated in
  //    the window. Filter to those that have revertPrNumber set so we
  //    only show one-click rollbacks, not policy-driven defers.
  try {
    const rolled = await withTenant(organizationId, (tx) =>
      tx.changeset.findMany({
        where: {
          projectId,
          status: 'rolled_back',
          updatedAt: { gte: startOfWindow, lt: endOfWindow },
          revertPrNumber: { not: null },
        },
        select: { id: true, title: true, revertPrNumber: true },
      }),
    );
    for (const cs of rolled) {
      anomalies.push({
        kind: 'rollback',
        changesetId: cs.id,
        title: cs.title,
        revertPrNumber: cs.revertPrNumber ?? 0,
        link: csUrl(cs.id),
      });
    }
  } catch {
    /* skip */
  }

  // 5. File-count spike — a single changeset whose file count exceeded
  //    2× the trailing-30-day median. Done via riskScoreBreakdown so we
  //    don't need to re-query getPullRequestFiles per row.
  try {
    const recent = await withTenant(organizationId, (tx) =>
      tx.changeset.findMany({
        where: {
          projectId,
          updatedAt: { gte: trailing30Start, lt: startOfWindow },
          riskScoreBreakdown: { not: undefined },
        },
        select: { riskScoreBreakdown: true },
      }),
    );
    const filesChangedHistory: number[] = [];
    for (const r of recent) {
      const v = (r.riskScoreBreakdown as { filesChanged?: number } | null)?.filesChanged;
      if (typeof v === 'number') filesChangedHistory.push(v);
    }
    if (filesChangedHistory.length >= 5) {
      filesChangedHistory.sort((a, b) => a - b);
      const median = filesChangedHistory[Math.floor(filesChangedHistory.length / 2)] ?? 0;
      const window = await withTenant(organizationId, (tx) =>
        tx.changeset.findMany({
          where: {
            projectId,
            updatedAt: { gte: startOfWindow, lt: endOfWindow },
            riskScoreBreakdown: { not: undefined },
          },
          select: { id: true, title: true, riskScoreBreakdown: true },
        }),
      );
      for (const cs of window) {
        const filesChanged =
          (cs.riskScoreBreakdown as { filesChanged?: number } | null)?.filesChanged ?? 0;
        if (filesChanged > median * FILE_SPIKE_MULTIPLIER && median > 0) {
          anomalies.push({
            kind: 'file_spike',
            changesetId: cs.id,
            title: cs.title,
            filesChanged,
            medianFiles: median,
            link: csUrl(cs.id),
          });
        }
      }
    }
  } catch {
    /* skip */
  }

  // 6. Eval regression (#304) — org-scoped. Compare the latest nightly
  //    eval run inside the digest window against the median pass-rate of
  //    historical runs in the trailing 7 days. Skip if fewer than
  //    EVAL_REGRESSION_MIN_HISTORY historical runs exist (signal is too
  //    noisy to act on). The anomaly may surface in multiple projects'
  //    digests if the org runs more than one — that's intentional: each
  //    project's reviewers should see it without coordinating.
  try {
    const todayRun = await withTenant(organizationId, (tx) =>
      tx.evalRun.findFirst({
        where: {
          organizationId,
          startedAt: { gte: startOfWindow, lt: endOfWindow },
          finishedAt: { not: null },
          totalCases: { gt: 0 },
        },
        orderBy: { startedAt: 'desc' },
        select: { id: true, totalCases: true, passCount: true },
      }),
    );
    if (todayRun) {
      const history = await withTenant(organizationId, (tx) =>
        tx.evalRun.findMany({
          where: {
            organizationId,
            startedAt: { gte: trailing7Start, lt: startOfWindow },
            finishedAt: { not: null },
            totalCases: { gt: 0 },
          },
          select: { totalCases: true, passCount: true },
        }),
      );
      if (history.length >= EVAL_REGRESSION_MIN_HISTORY) {
        const rates = history
          .map((r) => r.passCount / r.totalCases)
          .sort((a, b) => a - b);
        const trailingMedian = rates[Math.floor(rates.length / 2)] ?? 0;
        const todayPassRate = todayRun.passCount / todayRun.totalCases;
        const dropPct =
          trailingMedian > 0
            ? ((trailingMedian - todayPassRate) / trailingMedian) * 100
            : 0;
        if (dropPct > EVAL_REGRESSION_DROP_PCT) {
          anomalies.push({
            kind: 'eval_regression',
            todayPassRate,
            trailingMedian,
            dropPct,
            runId: todayRun.id,
            link: `${webBaseUrl}/orgs/${orgSlug}/evals/${todayRun.id}`,
          });
        }
      }
    }
  } catch {
    /* skip */
  }

  return anomalies;
}

function startOfUtcDay(d: Date): Date {
  const x = new Date(d);
  x.setUTCHours(0, 0, 0, 0);
  return x;
}
