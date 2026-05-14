import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { DEMO_CAREFUL_LIFECYCLE_PARSED, DEMO_CAREFUL_LIFECYCLE_YAML } from './demo-lifecycle.js';

export const DEMO_PROJECT_SLUG = 'demo-saas';
export const DEMO_PROJECT_NAME = 'Demo SaaS';

export interface SeedDemoProjectOptions {
  /**
   * When true, also wires a stub ConnectedRepo + dev DeployTarget so the
   * demo is runnable end-to-end against the stub agent backend. Used by
   * the local-compose seed (`MERGECREW_DEMO_MODE=1`) and the e2e harness.
   * Per-org seeding via `createOrg` leaves this off — the demo is a
   * read-only sandbox in production-like deployments (#437, #438).
   */
  wireStubExecution?: boolean;
  log?: (msg: string) => void;
}

/**
 * Seed a per-org `demo-saas` project (#437): the read-only sample
 * with a completed planner → coder → reviewer run, three agent steps,
 * a changeset, and the timeline events a real run produces. Idempotent
 * at the project level — re-running the seed for the same org is a
 * no-op once the project + sample run exist.
 *
 * Per-call UUIDs (vs the previous globally-stable ones) so multiple
 * orgs each get their own copies without collision.
 */
export async function seedDemoProject(
  prisma: PrismaClient,
  organizationId: string,
  opts: SeedDemoProjectOptions = {},
): Promise<{ projectId: string }> {
  const log = opts.log ?? (() => {});

  const demoProject = await prisma.project.upsert({
    where: { organizationId_slug: { organizationId, slug: DEMO_PROJECT_SLUG } },
    update: {},
    create: {
      organizationId,
      slug: DEMO_PROJECT_SLUG,
      name: DEMO_PROJECT_NAME,
      description:
        'Read-only demo project. Explore the seeded multi-agent run, then set up your own project from the wizard.',
      graphProfile: 'careful',
      demo: true,
    },
  });
  log(`[demo-seed] project "${demoProject.slug}" ready.`);

  const existingLc = await prisma.lifecycle.findFirst({
    where: { projectId: demoProject.id },
    orderBy: { version: 'desc' },
  });
  if (!existingLc) {
    await prisma.lifecycle.create({
      data: {
        organizationId,
        projectId: demoProject.id,
        version: 1,
        sourceYaml: DEMO_CAREFUL_LIFECYCLE_YAML,
        parsed: DEMO_CAREFUL_LIFECYCLE_PARSED,
      },
    });
    log(`[demo-seed] lifecycle v1 (careful: planner/coder/reviewer) created.`);
  }

  if (opts.wireStubExecution) {
    await prisma.connectedRepo.upsert({
      where: { projectId: demoProject.id },
      update: {},
      create: {
        organizationId,
        projectId: demoProject.id,
        vcsProvider: 'github',
        installationId: '0',
        repoId: '0',
        repoFullName: 'mergecrew/e2e-stub',
        defaultBranch: 'main',
      },
    });
    await prisma.deployTarget.upsert({
      where: { projectId_kind: { projectId: demoProject.id, kind: 'dev' } },
      update: {},
      create: {
        organizationId,
        projectId: demoProject.id,
        kind: 'dev',
        adapterId: 'github-actions',
        config: { workflowFile: 'deploy.yml' },
      },
    });
    log(`[demo-seed] stub repo + dev deploy target wired.`);
  }

  await seedSampleRun(prisma, { organizationId, projectId: demoProject.id, log });

  return { projectId: demoProject.id };
}

async function seedSampleRun(
  prisma: PrismaClient,
  opts: { organizationId: string; projectId: string; log: (msg: string) => void },
): Promise<void> {
  const { organizationId, projectId, log } = opts;
  const existing = await prisma.dailyRun.findFirst({
    where: { projectId },
    select: { id: true },
  });
  if (existing) return;

  const lc = await prisma.lifecycle.findFirst({
    where: { projectId },
    orderBy: { version: 'desc' },
    select: { id: true, parsed: true },
  });
  if (!lc) {
    log('[demo-seed] no lifecycle for sample run anchor; skipping sample run seed.');
    return;
  }
  const workflowId =
    ((lc.parsed as { lifecycle?: { workflows?: { id: string }[] } })?.lifecycle?.workflows ?? [])[0]
      ?.id ?? 'multi-agent';

  const RUN_ID = randomUUID();
  const WFR_ID = randomUUID();
  const PLANNER_ID = randomUUID();
  const CODER_ID = randomUUID();
  const REVIEWER_ID = randomUUID();
  const PLANNER_INST = randomUUID();
  const CODER_INST = randomUUID();
  const REVIEWER_INST = randomUUID();
  const CHANGESET_ID = randomUUID();

  const now = new Date();
  const ago = (mins: number) => new Date(now.getTime() - mins * 60_000);
  const SCHEDULED_AT = ago(70);
  const PLANNER_START = ago(65);
  const PLANNER_DONE = ago(63);
  const CODER_START = ago(63);
  const CODER_DONE = ago(58);
  const REVIEWER_START = ago(58);
  const REVIEWER_DONE = ago(57);
  const CHANGESET_OPENED = ago(58);
  const CHANGESET_DEPLOYED = ago(54);
  const RUN_DONE = ago(54);

  await prisma.dailyRun.create({
    data: {
      id: RUN_ID,
      organizationId,
      projectId,
      lifecycleId: lc.id,
      scheduledAt: SCHEDULED_AT,
      startedAt: SCHEDULED_AT,
      finishedAt: RUN_DONE,
      status: 'done',
      metadata: { manual: false, source: 'seed-sample' },
    },
  });
  await prisma.workflowRun.create({
    data: {
      id: WFR_ID,
      organizationId,
      dailyRunId: RUN_ID,
      workflowId,
      status: 'done',
      startedAt: SCHEDULED_AT,
      finishedAt: RUN_DONE,
    },
  });
  await prisma.agentStep.create({
    data: {
      id: PLANNER_ID,
      organizationId,
      workflowRunId: WFR_ID,
      agentKind: 'Planner',
      agentInstanceId: PLANNER_INST,
      graphNodeKey: 'planner',
      status: 'done',
      input: { agentRef: 'planner', workflowRunId: WFR_ID } as object,
      output: { planMarkdown: SAMPLE_PLAN_MARKDOWN } as object,
      startedAt: PLANNER_START,
      finishedAt: PLANNER_DONE,
      totalInputTokens: 2400,
      totalOutputTokens: 410,
      totalUsdEstimate: 0.075,
    },
  });
  await prisma.agentStep.create({
    data: {
      id: CODER_ID,
      organizationId,
      workflowRunId: WFR_ID,
      agentKind: 'Coder',
      agentInstanceId: CODER_INST,
      graphNodeKey: 'coder',
      status: 'done',
      input: { agentRef: 'coder', workflowRunId: WFR_ID } as object,
      startedAt: CODER_START,
      finishedAt: CODER_DONE,
      totalInputTokens: 14_200,
      totalOutputTokens: 3_100,
      totalUsdEstimate: 0.51,
    },
  });
  await prisma.agentStep.create({
    data: {
      id: REVIEWER_ID,
      organizationId,
      workflowRunId: WFR_ID,
      agentKind: 'Reviewer',
      agentInstanceId: REVIEWER_INST,
      graphNodeKey: 'reviewer',
      status: 'done',
      input: { agentRef: 'reviewer', workflowRunId: WFR_ID } as object,
      output: {
        verdict: 'approve',
        reasoning:
          'Plan covers the bug; the diff stays inside the listed files and adds a regression test. LGTM.',
        requestedChanges: [],
      } as object,
      startedAt: REVIEWER_START,
      finishedAt: REVIEWER_DONE,
      totalInputTokens: 4_800,
      totalOutputTokens: 320,
      totalUsdEstimate: 0.06,
    },
  });
  await prisma.changeset.create({
    data: {
      id: CHANGESET_ID,
      organizationId,
      projectId,
      dailyRunId: RUN_ID,
      workflowRunId: WFR_ID,
      title: 'Fix `/healthz` regression on the API service',
      whyParagraph:
        'A V2.ac change moved the health route behind the `/readyz` split; this restores the `/healthz` route the load balancer was checking and adds a regression test so future splits keep both routes wired.',
      branch: 'sample/fix-healthz',
      status: 'dev_deployed',
      riskChip: 'low',
      estimatedUsd: 0.65,
      createdAt: CHANGESET_OPENED,
      updatedAt: CHANGESET_DEPLOYED,
    },
  });

  const events = [
    { kind: 'RUN_STARTED', at: SCHEDULED_AT, actor: { kind: 'system' }, payload: { manual: false, lifecycleVersion: 1 }, agentStepId: null, changesetId: null },
    { kind: 'WORKFLOW_STARTED', at: SCHEDULED_AT, actor: { kind: 'system' }, payload: { workflowId }, agentStepId: null, changesetId: null },
    { kind: 'AGENT_STEP_STARTED', at: PLANNER_START, actor: { kind: 'system' }, payload: { agentRef: 'planner' }, agentStepId: PLANNER_ID, changesetId: null },
    { kind: 'PLAN_PROPOSED', at: PLANNER_DONE, actor: { kind: 'agent', id: PLANNER_ID, agentKind: 'Planner' }, payload: { planLength: SAMPLE_PLAN_MARKDOWN.length }, agentStepId: PLANNER_ID, changesetId: null },
    { kind: 'AGENT_STEP_COMPLETED', at: PLANNER_DONE, actor: { kind: 'system' }, payload: { totalTokens: 2810 }, agentStepId: PLANNER_ID, changesetId: null },
    { kind: 'AGENT_STEP_STARTED', at: CODER_START, actor: { kind: 'system' }, payload: { agentRef: 'coder' }, agentStepId: CODER_ID, changesetId: null },
    { kind: 'CHANGESET_OPENED', at: CHANGESET_OPENED, actor: { kind: 'agent', id: CODER_ID, agentKind: 'Coder' }, payload: { changesetId: CHANGESET_ID, title: 'Fix /healthz regression' }, agentStepId: CODER_ID, changesetId: CHANGESET_ID },
    { kind: 'AGENT_STEP_COMPLETED', at: CODER_DONE, actor: { kind: 'system' }, payload: { totalTokens: 17_300 }, agentStepId: CODER_ID, changesetId: null },
    { kind: 'AGENT_STEP_STARTED', at: REVIEWER_START, actor: { kind: 'system' }, payload: { agentRef: 'reviewer' }, agentStepId: REVIEWER_ID, changesetId: null },
    { kind: 'REVIEW_APPROVED', at: REVIEWER_DONE, actor: { kind: 'agent', id: REVIEWER_ID, agentKind: 'Reviewer' }, payload: { reasoning: 'lgtm', requestedChanges: [] }, agentStepId: REVIEWER_ID, changesetId: null },
    { kind: 'AGENT_STEP_COMPLETED', at: REVIEWER_DONE, actor: { kind: 'system' }, payload: { totalTokens: 5120 }, agentStepId: REVIEWER_ID, changesetId: null },
    { kind: 'CHANGESET_DEV_DEPLOYED', at: CHANGESET_DEPLOYED, actor: { kind: 'system' }, payload: { changesetId: CHANGESET_ID }, agentStepId: null, changesetId: CHANGESET_ID },
    { kind: 'WORKFLOW_COMPLETED', at: RUN_DONE, actor: { kind: 'system' }, payload: { workflowId }, agentStepId: null, changesetId: null },
    { kind: 'RUN_COMPLETED', at: RUN_DONE, actor: { kind: 'system' }, payload: {}, agentStepId: null, changesetId: null },
  ];

  for (const e of events) {
    await prisma.timelineEvent.create({
      data: {
        eventId: randomUUID(),
        organizationId,
        projectId,
        dailyRunId: RUN_ID,
        workflowRunId: WFR_ID,
        agentStepId: e.agentStepId,
        changesetId: e.changesetId,
        type: e.kind,
        actor: e.actor as object,
        payload: e.payload as object,
        occurredAt: e.at,
      },
    });
  }
  log(`[demo-seed] pre-baked sample run (id=${RUN_ID.slice(0, 8)}…) with 3 agent steps + 1 changeset + ${events.length} timeline events.`);
}

const SAMPLE_PLAN_MARKDOWN = `## Plan

### Goal
Restore the \`/healthz\` route on the API service. A recent split moved
liveness behind \`/readyz\`; the load balancer's health probe is still
configured for \`/healthz\` and now sees 404s.

### Files to touch
- \`apps/api/src/modules/health/health.controller.ts\` — re-add the
  \`/healthz\` GET handler (no I/O, returns 200 immediately).
- \`apps/api/test/health.e2e-spec.ts\` — new test asserting both
  \`/healthz\` and \`/readyz\` return 200 on a healthy stack.

### Files NOT to touch
- \`apps/api/src/modules/health/health.service.ts\` — readiness logic
  stays as-is.

### Validation
1. \`pnpm --filter @mergecrew/api test\` (covers the new e2e test).
2. \`curl localhost:3000/healthz\` returns 200.
3. \`curl localhost:3000/readyz\` returns 200 (regression guard).
`;
