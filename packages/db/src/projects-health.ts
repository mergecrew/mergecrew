import { getSystemPrisma } from './client.js';
import { evaluateSlo, type SloMetric, type SloState } from './slo-evaluator.js';

/**
 * Per-project SLO health (V2.af / #746). Folds the SLO evaluator
 * (#745) into a single worst-state-per-project view so org-overview
 * cards and project headers can render a health badge without an
 * N+1 fan-out.
 *
 * `unconfigured` is a distinct state — distinct from `OK` — so the
 * UI can prompt operators to define SLOs rather than implying
 * health was confirmed.
 */

export type ProjectHealthRow = {
  projectId: string;
  projectSlug: string;
  /** Worst state across the project's enabled SLOs, or `unconfigured`. */
  worstState: SloState | 'UNCONFIGURED';
  /** Names of SLOs currently breaching (empty when worstState is not BREACHING). */
  breachingSloNames: string[];
  /** Names of SLOs currently AT_RISK (empty when none). */
  atRiskSloNames: string[];
};

const STATE_RANK: Record<SloState | 'UNCONFIGURED', number> = {
  UNCONFIGURED: 0,
  OK: 1,
  INSUFFICIENT_DATA: 2,
  AT_RISK: 3,
  BREACHING: 4,
};

function worseState(
  a: SloState | 'UNCONFIGURED',
  b: SloState | 'UNCONFIGURED',
): SloState | 'UNCONFIGURED' {
  return STATE_RANK[a] >= STATE_RANK[b] ? a : b;
}

/**
 * Compute health for every project in an org. Returns one row per
 * project — including projects with no SLOs (worstState =
 * UNCONFIGURED) so the UI can render a placeholder badge.
 */
export async function computeOrgProjectsHealth(
  organizationId: string,
  opts?: { now?: Date },
): Promise<ProjectHealthRow[]> {
  const prisma = getSystemPrisma();
  const projects = await prisma.project.findMany({
    where: { organizationId, archivedAt: null },
    select: { id: true, slug: true },
  });
  const slos = await prisma.projectSlo.findMany({
    where: { organizationId, enabled: true },
  });

  const sloByProject = new Map<string, typeof slos>();
  for (const s of slos) {
    const arr = sloByProject.get(s.projectId) ?? [];
    arr.push(s);
    sloByProject.set(s.projectId, arr);
  }

  const rows: ProjectHealthRow[] = [];
  for (const p of projects) {
    const projectSlos = sloByProject.get(p.id) ?? [];
    if (projectSlos.length === 0) {
      rows.push({
        projectId: p.id,
        projectSlug: p.slug,
        worstState: 'UNCONFIGURED',
        breachingSloNames: [],
        atRiskSloNames: [],
      });
      continue;
    }
    const breaches: string[] = [];
    const atRisks: string[] = [];
    let worst: SloState | 'UNCONFIGURED' = 'OK';
    for (const s of projectSlos) {
      const r = await evaluateSlo(
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
        opts,
      );
      worst = worseState(worst, r.state);
      if (r.state === 'BREACHING') breaches.push(s.name);
      if (r.state === 'AT_RISK') atRisks.push(s.name);
    }
    rows.push({
      projectId: p.id,
      projectSlug: p.slug,
      worstState: worst,
      breachingSloNames: breaches,
      atRiskSloNames: atRisks,
    });
  }
  return rows;
}

/** Compute health for one project. */
export async function computeProjectHealth(
  organizationId: string,
  projectId: string,
  opts?: { now?: Date },
): Promise<ProjectHealthRow | null> {
  const prisma = getSystemPrisma();
  const project = await prisma.project.findFirst({
    where: { id: projectId, organizationId },
    select: { id: true, slug: true },
  });
  if (!project) return null;
  const slos = await prisma.projectSlo.findMany({
    where: { organizationId, projectId, enabled: true },
  });
  if (slos.length === 0) {
    return {
      projectId: project.id,
      projectSlug: project.slug,
      worstState: 'UNCONFIGURED',
      breachingSloNames: [],
      atRiskSloNames: [],
    };
  }
  const breaches: string[] = [];
  const atRisks: string[] = [];
  let worst: SloState | 'UNCONFIGURED' = 'OK';
  for (const s of slos) {
    const r = await evaluateSlo(
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
      opts,
    );
    worst = worseState(worst, r.state);
    if (r.state === 'BREACHING') breaches.push(s.name);
    if (r.state === 'AT_RISK') atRisks.push(s.name);
  }
  return {
    projectId: project.id,
    projectSlug: project.slug,
    worstState: worst,
    breachingSloNames: breaches,
    atRiskSloNames: atRisks,
  };
}
