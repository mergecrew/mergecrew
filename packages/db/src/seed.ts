/* eslint-disable no-console */
import { createHash } from 'node:crypto';
import { PrismaClient } from '@prisma/client';

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
  // both have somewhere to land. Lifecycle rows are created lazily by
  // the API on the first GET. The project ships paused (no repo, no
  // deploy target) per #229 — the e2e branch below wires fakes only
  // when MERGECREW_AGENT_STUB + MERGECREW_E2E_LOCAL_API_KEY are set.
  const demoProject = await prisma.project.upsert({
    where: { organizationId_slug: { organizationId: demoOrg.id, slug: 'acme' } },
    update: {},
    create: {
      organizationId: demoOrg.id,
      slug: 'acme',
      name: 'Acme',
      description: 'Default demo project. Edit or replace from the org Projects page.',
    },
  });
  console.log(`[seed] Demo project "${demoProject.slug}" ready.`);

  // Minimal lifecycle row so the orchestrator's `run.due` handler doesn't
  // bail with `no lifecycle` before a real YAML lands. The API auto-creates
  // a fuller default on first lifecycle GET; this just covers the case
  // where a run is triggered before anyone touches the lifecycle page —
  // which is exactly what the local e2e (#228) does.
  const minimalLifecycle = {
    version: 1,
    lifecycle: {
      workflows: [
        { id: 'discovery', agents: ['discovery'], out: [], transitions: [] },
      ],
    },
    agents: {
      discovery: {
        kind: 'Discovery',
        description: 'Seed-time placeholder agent.',
        fallback: [],
        skills: [],
        do_not_touch: [],
        maxStepsPerRun: 12,
        maxToolCallsPerStep: 8,
      },
    },
    skills: {},
  };
  const minimalYaml =
    'version: 1\nlifecycle:\n  workflows:\n    - id: discovery\n      agents: [discovery]\n      out: []\nagents:\n  discovery:\n    kind: Discovery\n    description: Seed-time placeholder agent.\nskills: {}\n';
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
        sourceYaml: minimalYaml,
        parsed: minimalLifecycle,
      },
    });
    console.log(`[seed] Seed lifecycle v1 created for project "${demoProject.slug}".`);
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

  console.log('[seed] Done.');
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
