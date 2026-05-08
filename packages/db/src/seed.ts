/* eslint-disable no-console */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

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
  console.log('[seed] Done.');
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
