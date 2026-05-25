/* eslint-disable no-console */
import { createHash } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { makePgAdapter } from './adapter.js';
import { seedDemoProject } from './demo-project-seed.js';

const prisma = new PrismaClient({ adapter: makePgAdapter() });
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

  // V2.af: demo org is the deployment owner in single-tenant self-host —
  // wire it to `instance_builtin` so docker-compose-up demos can run
  // immediately without going through the runner-profile settings UI.
  await prisma.runnerProfile.upsert({
    where: { organizationId: demoOrg.id },
    update: {},
    create: { organizationId: demoOrg.id, kind: 'instance_builtin' },
  });

  console.log(`[seed] Demo org "${demoOrg.slug}" + user "${demoUser.email}" ready.`);

  // The demo org's project ships **paused** for the read-only sandbox UX
  // (#437). Two env flags flip it into "runnable" against the stub agent
  // backend — neither hits a real provider, both short-circuit before
  // any outbound call:
  //   1. MERGECREW_DEMO_MODE=1 (#372, V2.ag) — the operator's no-creds
  //      click-to-run local dev experience. Default in
  //      `docker-compose.full.yml`.
  //   2. MERGECREW_AGENT_STUB=1 + MERGECREW_E2E_LOCAL_API_KEY (#228) —
  //      the local-stack e2e harness.
  const wireStubExecution =
    process.env.MERGECREW_DEMO_MODE === '1' ||
    Boolean(process.env.MERGECREW_AGENT_STUB === '1' && process.env.MERGECREW_E2E_LOCAL_API_KEY);

  await seedDemoProject(prisma, demoOrg.id, {
    wireStubExecution,
    log: (msg) => console.log(`[seed] ${msg}`),
  });

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
