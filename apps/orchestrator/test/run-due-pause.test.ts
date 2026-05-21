/**
 * Operator kill switch (#625) — orchestrator-side enforcement.
 *
 * The worker-cron tick and the runNow API both refuse to enqueue when a
 * project or its org has runsPausedAt set, so an arriving run.due job
 * with a paused project means a race (pause flipped on between enqueue
 * and pickup). The orchestrator's defensive check must cancel the
 * pre-created DailyRun (when the API path created one) and emit
 * RUN_CANCELLED so the run-detail page tells the operator why nothing
 * happened. No LLM tokens get spent.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import IORedis from 'ioredis';
import pino from 'pino';
import { PrismaClient } from '@prisma/client';
import { Orchestrator } from '../src/orchestrator.js';
import type { Eventlog } from '@mergecrew/eventlog';

const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';
const TEST_PREFIX = `pause-test-${Date.now()}`;

const prisma = new PrismaClient();
const conn = new IORedis(REDIS_URL, { maxRetriesPerRequest: null });

interface RecordedEvent {
  type: string;
  payload?: Record<string, unknown>;
  dailyRunId?: string | null;
}
const recorded: RecordedEvent[] = [];
const eventlog = {
  emit: async (e: { type: string; payload?: any; dailyRunId?: string | null }) => {
    recorded.push({ type: e.type, payload: e.payload, dailyRunId: e.dailyRunId ?? null });
  },
} as unknown as Eventlog;

const orchestrator = new Orchestrator({
  connection: conn,
  eventlog,
  logger: pino({ level: 'silent' }),
});

interface Seed {
  organizationId: string;
  projectId: string;
  lifecycleId: string;
  runId: string;
}

async function seedRun(args: {
  slug: string;
  orgPaused?: boolean;
  projectPaused?: boolean;
}): Promise<Seed> {
  const now = new Date();
  const org = await prisma.organization.create({
    data: {
      slug: `${TEST_PREFIX}-${args.slug}`,
      name: `Pause ${args.slug}`,
      ...(args.orgPaused ? { runsPausedAt: now, runsPauseReason: 'budget freeze' } : {}),
    },
  });
  const project = await prisma.project.create({
    data: {
      organizationId: org.id,
      slug: 'p',
      name: 'P',
      ...(args.projectPaused ? { runsPausedAt: now, runsPauseReason: 'flaky agent' } : {}),
    },
  });
  const lifecycle = await prisma.lifecycle.create({
    data: {
      organizationId: org.id,
      projectId: project.id,
      version: 1,
      sourceYaml: '',
      parsed: { lifecycle: { workflows: [{ id: 'wf-1', agents: [], out: [] }] }, agents: {} } as any,
    },
  });
  // API path pre-creates a pending DailyRun and passes its id in the
  // run.due payload. We replicate that here so we can assert it gets
  // cancelled, which is the load-bearing behavior.
  const run = await prisma.dailyRun.create({
    data: {
      organizationId: org.id,
      projectId: project.id,
      lifecycleId: lifecycle.id,
      scheduledAt: now,
      status: 'pending',
    },
  });
  return { organizationId: org.id, projectId: project.id, lifecycleId: lifecycle.id, runId: run.id };
}

async function cleanupOrg(organizationId: string) {
  await prisma.dailyRun.deleteMany({ where: { organizationId } });
  await prisma.lifecycle.deleteMany({ where: { organizationId } });
  await prisma.project.deleteMany({ where: { organizationId } });
  await prisma.organization.delete({ where: { id: organizationId } });
}

const seeds: Seed[] = [];

afterAll(async () => {
  for (const s of seeds) {
    await cleanupOrg(s.organizationId).catch(() => {});
  }
  await prisma.$disconnect();
  await conn.quit();
});

describe('handleRunDue: pause enforcement (#625)', () => {
  it('cancels the pre-created run and emits RUN_CANCELLED when project is paused', async () => {
    const seed = await seedRun({ slug: 'project', projectPaused: true });
    seeds.push(seed);
    recorded.length = 0;

    await orchestrator.handleRunDue({
      organizationId: seed.organizationId,
      projectId: seed.projectId,
      runId: seed.runId,
      manual: true,
    });

    const after = await prisma.dailyRun.findUnique({ where: { id: seed.runId } });
    expect(after?.status).toBe('cancelled');
    expect((after?.metadata as any)?.cancelReason).toBe('paused');
    expect((after?.metadata as any)?.pauseScope).toBe('project');

    const types = recorded.map((e) => e.type);
    expect(types).toContain('RUN_CANCELLED');
    expect(types).not.toContain('RUN_STARTED');
  });

  it('cancels with scope=org when the org is paused', async () => {
    const seed = await seedRun({ slug: 'org', orgPaused: true });
    seeds.push(seed);
    recorded.length = 0;

    await orchestrator.handleRunDue({
      organizationId: seed.organizationId,
      projectId: seed.projectId,
      runId: seed.runId,
    });

    const after = await prisma.dailyRun.findUnique({ where: { id: seed.runId } });
    expect(after?.status).toBe('cancelled');
    expect((after?.metadata as any)?.pauseScope).toBe('org');
    expect(recorded.map((e) => e.type)).not.toContain('RUN_STARTED');
  });

  it('org pause takes precedence over project pause', async () => {
    const seed = await seedRun({ slug: 'both', orgPaused: true, projectPaused: true });
    seeds.push(seed);
    recorded.length = 0;

    await orchestrator.handleRunDue({
      organizationId: seed.organizationId,
      projectId: seed.projectId,
      runId: seed.runId,
    });

    const after = await prisma.dailyRun.findUnique({ where: { id: seed.runId } });
    expect((after?.metadata as any)?.pauseScope).toBe('org');
  });
});
