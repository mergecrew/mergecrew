/* eslint-disable no-console */
import { createHash } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { DEMO_CAREFUL_LIFECYCLE_PARSED, DEMO_CAREFUL_LIFECYCLE_YAML } from './demo-lifecycle.js';

const prisma = new PrismaClient();
const API_KEY_PREFIX = 'mc_live_';

async function main() {
  console.log('[seed] Starting seed…');

  // Price table: representative rows for V1 pricing.
  const prices = [
    { providerKind: 'anthropic', modelId: 'claude-opus-4-7', input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
    { providerKind: 'anthropic', modelId: 'claude-sonnet-4-6', input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
    { providerKind: 'anthropic', modelId: 'claude-haiku-4-5-20251001', input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
    { providerKind: 'openai', modelId: 'gpt-5', input: 5, output: 20, cacheRead: 0.5, cacheWrite: null },
    { providerKind: 'openai', modelId: 'gpt-5-codex', input: 4, output: 16, cacheRead: 0.4, cacheWrite: null },
    { providerKind: 'openai', modelId: 'text-embedding-3-small', input: 0.02, output: 0, cacheRead: null, cacheWrite: null },
    { providerKind: 'bedrock', modelId: 'anthropic.claude-opus-4-7', input: 15, output: 75, cacheRead: null, cacheWrite: null },
    { providerKind: 'bedrock', modelId: 'anthropic.claude-sonnet-4-6', input: 3, output: 15, cacheRead: null, cacheWrite: null },
    { providerKind: 'ollama', modelId: 'qwen3:32b', input: 0, output: 0, cacheRead: null, cacheWrite: null },
  ];

  for (const p of prices) {
    await prisma.modelPriceTable.upsert({
      where: {
        providerKind_modelId_effectiveAt: {
          providerKind: p.providerKind,
          modelId: p.modelId,
          effectiveAt: new Date('2026-01-01T00:00:00Z'),
        },
      },
      update: {},
      create: {
        providerKind: p.providerKind,
        modelId: p.modelId,
        effectiveAt: new Date('2026-01-01T00:00:00Z'),
        inputPerMillionUsd: p.input,
        outputPerMillionUsd: p.output,
        cacheReadPerMillionUsd: p.cacheRead ?? null,
        cacheWritePerMillionUsd: p.cacheWrite ?? null,
      },
    });
  }
  console.log(`[seed] Upserted ${prices.length} price rows.`);

  // Demo org for local dev.
  const demoOrg = await prisma.organization.upsert({
    where: { slug: 'demo' },
    update: {},
    create: {
      slug: 'demo',
      name: 'Demo Org',
      timezone: 'America/Sao_Paulo',
    },
  });

  const demoUser = await prisma.user.upsert({
    where: { email: 'demo@mergecrew.local' },
    update: {},
    create: {
      email: 'demo@mergecrew.local',
      name: 'Demo User',
      defaultOrgId: demoOrg.id,
    },
  });

  await prisma.membership.upsert({
    where: { organizationId_userId: { organizationId: demoOrg.id, userId: demoUser.id } },
    update: {},
    create: {
      organizationId: demoOrg.id,
      userId: demoUser.id,
      role: 'owner',
    },
  });

  console.log(`[seed] Demo org "${demoOrg.slug}" + user "${demoUser.email}" ready.`);

  // Demo project so the local-stack e2e (#228) and dev clicks-through
  // both have somewhere to land. Ships on `graphProfile=careful` (#361,
  // V2.af) so the first run a visitor triggers shows off the
  // planner → coder → reviewer multi-agent chain rather than the V1
  // single-agent fallback. The lifecycle below wires the three agents
  // with stock-friendly skill bindings; the runtime's resolver upgrades
  // to STOCK_AGENTS where useful.
  const demoProject = await prisma.project.upsert({
    where: { organizationId_slug: { organizationId: demoOrg.id, slug: 'acme' } },
    // `update: {}` is intentional — existing demo projects (set up
    // before this seed change) stay on whatever graphProfile their
    // operator chose. The careful default only applies to fresh boots.
    update: {},
    create: {
      organizationId: demoOrg.id,
      slug: 'acme',
      name: 'Acme',
      description: 'Default demo project. Edit or replace from the org Projects page.',
      graphProfile: 'careful',
    },
  });
  console.log(`[seed] Demo project "${demoProject.slug}" ready.`);

  // Multi-agent lifecycle: matches CAREFUL_GRAPH's node keys (planner /
  // coder / reviewer). Operator-defined here so the Lifecycle page in
  // the UI shows the three agents; the orchestrator's resolveAgentByRef
  // still falls back to STOCK_AGENTS for any agent the operator drops.
  // The workflow's `agents` list is informational under careful — the
  // orchestrator dispatches via CAREFUL_GRAPH, not via this array.
  // The YAML body + parsed JSON live in `./demo-lifecycle.ts` so the
  // shape is unit-testable against the domain validator without pulling
  // in the seed script's PrismaClient side effect.
  const existingLc = await prisma.lifecycle.findFirst({
    where: { projectId: demoProject.id },
    orderBy: { version: 'desc' },
  });
  if (!existingLc) {
    await prisma.lifecycle.create({
      data: {
        organizationId: demoOrg.id,
        projectId: demoProject.id,
        version: 1,
        sourceYaml: DEMO_CAREFUL_LIFECYCLE_YAML,
        parsed: DEMO_CAREFUL_LIFECYCLE_PARSED,
      },
    });
    console.log(`[seed] Seed lifecycle v1 (careful: planner/coder/reviewer) created for "${demoProject.slug}".`);
  }

  // The demo project ships **paused** for trial users (#229) — no
  // connectedRepo, no deployTargets, so /v1/.../runs and the cron
  // scheduler both stay disabled until the operator wires them up.
  //
  // For the local e2e (#228) we need the project to be runnable: the
  // harness flips MERGECREW_AGENT_STUB=1 and MERGECREW_E2E_LOCAL_API_KEY
  // together, so we only fill in fake repo + dev target when both are
  // set. The stub agent path never actually hits GitHub or the deploy
  // adapter, so these dummy values exist purely to satisfy the new
  // runNow / cron preconditions.
  if (process.env.MERGECREW_AGENT_STUB === '1' && process.env.MERGECREW_E2E_LOCAL_API_KEY) {
    await prisma.connectedRepo.upsert({
      where: { projectId: demoProject.id },
      update: {},
      create: {
        organizationId: demoOrg.id,
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
        organizationId: demoOrg.id,
        projectId: demoProject.id,
        kind: 'dev',
        adapterId: 'github-actions',
        config: { workflowFile: 'deploy.yml' },
      },
    });
    console.log(`[seed] e2e stub repo + dev deploy target wired for project "${demoProject.slug}".`);
  }

  // Optional: pre-issue an API key whose plaintext matches
  // MERGECREW_E2E_LOCAL_API_KEY. The local-stack e2e (#228) sets this
  // before bringing up compose so the harness CLI can hit the API
  // without going through the OAuth dev-auto-login path.
  //
  // The token must start with `mc_live_`; we store only its sha256.
  const e2eToken = process.env.MERGECREW_E2E_LOCAL_API_KEY;
  if (e2eToken) {
    if (!e2eToken.startsWith(API_KEY_PREFIX)) {
      console.error(`[seed] MERGECREW_E2E_LOCAL_API_KEY must start with "${API_KEY_PREFIX}"`);
      process.exit(1);
    }
    const tokenHash = createHash('sha256').update(e2eToken).digest('hex');
    await prisma.apiKey.upsert({
      where: { tokenHash },
      update: {},
      create: {
        organizationId: demoOrg.id,
        name: 'e2e-local',
        tokenHash,
        prefix: e2eToken.slice(0, API_KEY_PREFIX.length + 4),
        role: 'operator',
        createdByUserId: demoUser.id,
      },
    });
    console.log(`[seed] e2e-local API key registered (role=operator).`);
  }

  await seedSampleRun({
    organizationId: demoOrg.id,
    projectId: demoProject.id,
  });

  console.log('[seed] Done.');
}

/**
 * Pre-baked completed careful-profile run (#362, V2.af). Makes the
 * Today page, Activity feed, run-detail, and Changesets list all
 * non-empty on fresh boot. The run is fully realized — three agent
 * steps, a changeset, the timeline events a real run produces — so
 * a visitor can click through and see what mergecrew looks like
 * without having to trigger their own run first.
 *
 * Idempotent via stable UUIDs: re-running the seed is a no-op once
 * the sample rows exist.
 */
async function seedSampleRun(opts: { organizationId: string; projectId: string }) {
  const { organizationId, projectId } = opts;
  const existingRun = await prisma.dailyRun.findUnique({ where: { id: SAMPLE_RUN_ID } });
  if (existingRun) return; // already seeded

  // Anchor everything to the lifecycle's `multi-agent` workflow. If
  // demo-lifecycle.ts ever renames it, the seeded run picks up the new
  // id automatically via the lookup below.
  const lc = await prisma.lifecycle.findFirst({
    where: { projectId },
    orderBy: { version: 'desc' },
    select: { id: true, parsed: true },
  });
  if (!lc) {
    console.log('[seed] No lifecycle for sample run anchor; skipping sample run seed.');
    return;
  }
  const workflowId = ((lc.parsed as { lifecycle?: { workflows?: { id: string }[] } })?.lifecycle
    ?.workflows ?? [])[0]?.id ?? 'multi-agent';

  // Times are wall-clock so the Activity feed orders them sensibly.
  // Pinning to "an hour ago" keeps the demo looking fresh on every boot.
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
      id: SAMPLE_RUN_ID,
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
      id: SAMPLE_WFR_ID,
      organizationId,
      dailyRunId: SAMPLE_RUN_ID,
      workflowId,
      status: 'done',
      startedAt: SCHEDULED_AT,
      finishedAt: RUN_DONE,
    },
  });
  await prisma.agentStep.create({
    data: {
      id: SAMPLE_PLANNER_STEP_ID,
      organizationId,
      workflowRunId: SAMPLE_WFR_ID,
      agentKind: 'Planner',
      agentInstanceId: '00000000-0000-4000-a000-000000000001',
      graphNodeKey: 'planner',
      status: 'done',
      input: { agentRef: 'planner', workflowRunId: SAMPLE_WFR_ID } as object,
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
      id: SAMPLE_CODER_STEP_ID,
      organizationId,
      workflowRunId: SAMPLE_WFR_ID,
      agentKind: 'Coder',
      agentInstanceId: '00000000-0000-4000-a000-000000000002',
      graphNodeKey: 'coder',
      status: 'done',
      input: { agentRef: 'coder', workflowRunId: SAMPLE_WFR_ID } as object,
      // Coder steps don't persist a structured output in V2.ae — the
      // changeset row is the artifact. Skip output so Prisma leaves
      // the column null.
      startedAt: CODER_START,
      finishedAt: CODER_DONE,
      totalInputTokens: 14_200,
      totalOutputTokens: 3_100,
      totalUsdEstimate: 0.51,
    },
  });
  await prisma.agentStep.create({
    data: {
      id: SAMPLE_REVIEWER_STEP_ID,
      organizationId,
      workflowRunId: SAMPLE_WFR_ID,
      agentKind: 'Reviewer',
      agentInstanceId: '00000000-0000-4000-a000-000000000003',
      graphNodeKey: 'reviewer',
      status: 'done',
      input: { agentRef: 'reviewer', workflowRunId: SAMPLE_WFR_ID } as object,
      output: {
        verdict: 'approve',
        reasoning: 'Plan covers the bug; the diff stays inside the listed files and adds a regression test. LGTM.',
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
      id: SAMPLE_CHANGESET_ID,
      organizationId,
      projectId,
      dailyRunId: SAMPLE_RUN_ID,
      workflowRunId: SAMPLE_WFR_ID,
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

  // Timeline events. The exact set the run-detail page draws from to
  // render the Agents card + the Timeline tab. eventId is the unique
  // SSE marker; we pin them to deterministic uuids so re-seeding (after
  // the early-return above is bypassed during local development) stays
  // stable.
  const events = [
    { kind: 'RUN_STARTED', at: SCHEDULED_AT, eventId: '00000000-0000-4000-a000-000000000101', actor: { kind: 'system' }, payload: { manual: false, lifecycleVersion: 1 }, agentStepId: null, changesetId: null },
    { kind: 'WORKFLOW_STARTED', at: SCHEDULED_AT, eventId: '00000000-0000-4000-a000-000000000102', actor: { kind: 'system' }, payload: { workflowId }, agentStepId: null, changesetId: null },
    { kind: 'AGENT_STEP_STARTED', at: PLANNER_START, eventId: '00000000-0000-4000-a000-000000000103', actor: { kind: 'system' }, payload: { agentRef: 'planner' }, agentStepId: SAMPLE_PLANNER_STEP_ID, changesetId: null },
    { kind: 'PLAN_PROPOSED', at: PLANNER_DONE, eventId: '00000000-0000-4000-a000-000000000104', actor: { kind: 'agent', id: SAMPLE_PLANNER_STEP_ID, agentKind: 'Planner' }, payload: { planLength: SAMPLE_PLAN_MARKDOWN.length }, agentStepId: SAMPLE_PLANNER_STEP_ID, changesetId: null },
    { kind: 'AGENT_STEP_COMPLETED', at: PLANNER_DONE, eventId: '00000000-0000-4000-a000-000000000105', actor: { kind: 'system' }, payload: { totalTokens: 2810 }, agentStepId: SAMPLE_PLANNER_STEP_ID, changesetId: null },
    { kind: 'AGENT_STEP_STARTED', at: CODER_START, eventId: '00000000-0000-4000-a000-000000000106', actor: { kind: 'system' }, payload: { agentRef: 'coder' }, agentStepId: SAMPLE_CODER_STEP_ID, changesetId: null },
    { kind: 'CHANGESET_OPENED', at: CHANGESET_OPENED, eventId: '00000000-0000-4000-a000-000000000107', actor: { kind: 'agent', id: SAMPLE_CODER_STEP_ID, agentKind: 'Coder' }, payload: { changesetId: SAMPLE_CHANGESET_ID, title: 'Fix /healthz regression' }, agentStepId: SAMPLE_CODER_STEP_ID, changesetId: SAMPLE_CHANGESET_ID },
    { kind: 'AGENT_STEP_COMPLETED', at: CODER_DONE, eventId: '00000000-0000-4000-a000-000000000108', actor: { kind: 'system' }, payload: { totalTokens: 17_300 }, agentStepId: SAMPLE_CODER_STEP_ID, changesetId: null },
    { kind: 'AGENT_STEP_STARTED', at: REVIEWER_START, eventId: '00000000-0000-4000-a000-000000000109', actor: { kind: 'system' }, payload: { agentRef: 'reviewer' }, agentStepId: SAMPLE_REVIEWER_STEP_ID, changesetId: null },
    { kind: 'REVIEW_APPROVED', at: REVIEWER_DONE, eventId: '00000000-0000-4000-a000-00000000010a', actor: { kind: 'agent', id: SAMPLE_REVIEWER_STEP_ID, agentKind: 'Reviewer' }, payload: { reasoning: 'lgtm', requestedChanges: [] }, agentStepId: SAMPLE_REVIEWER_STEP_ID, changesetId: null },
    { kind: 'AGENT_STEP_COMPLETED', at: REVIEWER_DONE, eventId: '00000000-0000-4000-a000-00000000010b', actor: { kind: 'system' }, payload: { totalTokens: 5120 }, agentStepId: SAMPLE_REVIEWER_STEP_ID, changesetId: null },
    { kind: 'CHANGESET_DEV_DEPLOYED', at: CHANGESET_DEPLOYED, eventId: '00000000-0000-4000-a000-00000000010c', actor: { kind: 'system' }, payload: { changesetId: SAMPLE_CHANGESET_ID }, agentStepId: null, changesetId: SAMPLE_CHANGESET_ID },
    { kind: 'WORKFLOW_COMPLETED', at: RUN_DONE, eventId: '00000000-0000-4000-a000-00000000010d', actor: { kind: 'system' }, payload: { workflowId }, agentStepId: null, changesetId: null },
    { kind: 'RUN_COMPLETED', at: RUN_DONE, eventId: '00000000-0000-4000-a000-00000000010e', actor: { kind: 'system' }, payload: {}, agentStepId: null, changesetId: null },
  ];

  for (const e of events) {
    await prisma.timelineEvent.create({
      data: {
        eventId: e.eventId,
        organizationId,
        projectId,
        dailyRunId: SAMPLE_RUN_ID,
        workflowRunId: SAMPLE_WFR_ID,
        agentStepId: e.agentStepId,
        changesetId: e.changesetId,
        type: e.kind,
        actor: e.actor as object,
        payload: e.payload as object,
        occurredAt: e.at,
      },
    });
  }
  console.log(`[seed] Pre-baked sample run (id=${SAMPLE_RUN_ID.slice(0, 8)}…) with 3 agent steps + 1 changeset + ${events.length} timeline events.`);
}

// Stable IDs for the pre-baked sample run (#362). Putting them in
// constants keeps the upsert path and any future "delete sample data"
// tooling pointed at the same rows.
const SAMPLE_RUN_ID = '00000000-0000-4000-a000-000000000010';
const SAMPLE_WFR_ID = '00000000-0000-4000-a000-000000000011';
const SAMPLE_PLANNER_STEP_ID = '00000000-0000-4000-a000-000000000012';
const SAMPLE_CODER_STEP_ID = '00000000-0000-4000-a000-000000000013';
const SAMPLE_REVIEWER_STEP_ID = '00000000-0000-4000-a000-000000000014';
const SAMPLE_CHANGESET_ID = 'cs-demo-sample-1';

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


main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
