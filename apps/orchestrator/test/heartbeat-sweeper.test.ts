/**
 * V1.4 exit-criterion test (#10): killing a runner mid-step must result
 * in the step being re-dispatched.
 *
 * The runner stamps `agent_steps.heartbeat_at` on a timer while it
 * executes. If the runner dies (OOM, ECS drain, network partition) those
 * writes stop. The orchestrator's `HeartbeatSweeper` scans for steps in
 * `running` whose heartbeat is older than `staleAfterMs` and re-enqueues
 * them, capped by `maxAttempts` so a poison-pill input doesn't loop.
 *
 * We don't actually fork a runner here — we simulate the symptom by
 * inserting a step in `running` with a stale `heartbeatAt` and asserting
 * the sweeper re-enqueues it on the next tick. The cap-reached path is
 * also covered: at `attempt >= maxAttempts` the step must be marked
 * failed so the workflow can advance instead of stalling.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import IORedis from 'ioredis';
import { Queue, QueueEvents } from 'bullmq';
import pino from 'pino';
import { PrismaClient } from '@prisma/client';
import { HeartbeatSweeper } from '../src/heartbeat-sweeper.js';
import type { Eventlog } from '@mergecrew/eventlog';

const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';
const TEST_PREFIX = `hb-test-${Date.now()}`;

const prisma = new PrismaClient();
const conn = new IORedis(REDIS_URL, { maxRetriesPerRequest: null });
const eventlogStub = { emit: async () => undefined } as unknown as Eventlog;

interface Seed {
  organizationId: string;
  projectId: string;
  lifecycleId: string;
  runId: string;
  workflowRunId: string;
  stepId: string;
}

async function seedRunningStep(args: {
  slug: string;
  attempt: number;
  heartbeatAgeMs: number;
}): Promise<Seed> {
  const org = await prisma.organization.create({
    data: { slug: `${TEST_PREFIX}-${args.slug}`, name: `HB ${args.slug}` },
  });
  const project = await prisma.project.create({
    data: { organizationId: org.id, slug: 'p', name: 'P' },
  });
  const lifecycle = await prisma.lifecycle.create({
    data: {
      organizationId: org.id,
      projectId: project.id,
      version: 1,
      sourceYaml: '',
      parsed: { lifecycle: { workflows: [] }, agents: {} } as any,
    },
  });
  const run = await prisma.dailyRun.create({
    data: {
      organizationId: org.id,
      projectId: project.id,
      lifecycleId: lifecycle.id,
      scheduledAt: new Date(),
      status: 'running',
    },
  });
  const wfr = await prisma.workflowRun.create({
    data: {
      organizationId: org.id,
      dailyRunId: run.id,
      workflowId: 'wf-1',
      status: 'running',
      startedAt: new Date(),
    },
  });
  const step = await prisma.agentStep.create({
    data: {
      organizationId: org.id,
      workflowRunId: wfr.id,
      agentKind: 'discovery',
      agentInstanceId: '00000000-0000-4000-a000-000000000001',
      attempt: args.attempt,
      status: 'running',
      input: { agentRef: 'discovery' } as any,
      startedAt: new Date(Date.now() - args.heartbeatAgeMs - 5_000),
      heartbeatAt: new Date(Date.now() - args.heartbeatAgeMs),
    },
  });
  return {
    organizationId: org.id,
    projectId: project.id,
    lifecycleId: lifecycle.id,
    runId: run.id,
    workflowRunId: wfr.id,
    stepId: step.id,
  };
}

async function cleanupOrg(organizationId: string) {
  await prisma.runPause.deleteMany({ where: { organizationId } });
  await prisma.approvalRequest.deleteMany({ where: { organizationId } });
  await prisma.agentStep.deleteMany({ where: { organizationId } });
  await prisma.workflowRun.deleteMany({ where: { organizationId } });
  await prisma.dailyRun.deleteMany({ where: { organizationId } });
  await prisma.lifecycle.deleteMany({ where: { organizationId } });
  await prisma.project.deleteMany({ where: { organizationId } });
  await prisma.organization.delete({ where: { id: organizationId } });
}

const seeds: Seed[] = [];
const runnerQueue = new Queue('runner.step', { connection: conn });

beforeAll(async () => {
  await runnerQueue.obliterate({ force: true }).catch(() => {});
});

afterAll(async () => {
  for (const s of seeds) {
    await cleanupOrg(s.organizationId).catch(() => {});
  }
  await runnerQueue.close();
  await prisma.$disconnect();
  await conn.quit();
});

describe('HeartbeatSweeper', () => {
  it('re-enqueues a step whose heartbeat went stale', async () => {
    const seed = await seedRunningStep({
      slug: 're',
      attempt: 1,
      heartbeatAgeMs: 120_000, // > default staleAfterMs (90s)
    });
    seeds.push(seed);

    const events = new QueueEvents('runner.step', { connection: conn.duplicate() });
    await events.waitUntilReady();
    let added: string[] = [];
    events.on('added', (job) => {
      if (job.name === 'step') added.push(job.jobId);
    });

    const sweeper = new HeartbeatSweeper({
      runnerQueue,
      eventlog: eventlogStub,
      logger: pino({ level: 'silent' }),
      // use defaults for staleAfterMs (90s) + maxAttempts (3)
    });
    // Drive a single tick directly — we don't want to wait 30s for the
    // setInterval to fire.
    await (sweeper as any).tick();

    await new Promise((r) => setTimeout(r, 100)); // let the `added` event drain
    expect(added.length).toBeGreaterThanOrEqual(1);

    // Heartbeat must be refreshed so the next sweep doesn't immediately
    // re-trigger before the new runner picks the job up.
    const refreshed = await prisma.agentStep.findUnique({ where: { id: seed.stepId } });
    expect(refreshed?.heartbeatAt).not.toBeNull();
    const ageMs = Date.now() - (refreshed?.heartbeatAt?.getTime() ?? 0);
    expect(ageMs).toBeLessThan(5_000);

    await events.close();
  });

  it('marks the step failed once attempts exceed maxAttempts', async () => {
    const seed = await seedRunningStep({
      slug: 'cap',
      attempt: 3, // already at default maxAttempts
      heartbeatAgeMs: 120_000,
    });
    seeds.push(seed);

    const sweeper = new HeartbeatSweeper({
      runnerQueue,
      eventlog: eventlogStub,
      logger: pino({ level: 'silent' }),
    });
    await (sweeper as any).tick();

    const step = await prisma.agentStep.findUnique({ where: { id: seed.stepId } });
    expect(step?.status).toBe('failed');
    expect(step?.failureReason).toMatch(/runner_dead/);
    expect(step?.heartbeatAt).toBeNull();
  });

  it('leaves a fresh-heartbeat step alone', async () => {
    const seed = await seedRunningStep({
      slug: 'fresh',
      attempt: 1,
      heartbeatAgeMs: 5_000, // well under the default 90s threshold
    });
    seeds.push(seed);

    const sweeper = new HeartbeatSweeper({
      runnerQueue,
      eventlog: eventlogStub,
      logger: pino({ level: 'silent' }),
    });
    await (sweeper as any).tick();

    const step = await prisma.agentStep.findUnique({ where: { id: seed.stepId } });
    expect(step?.status).toBe('running');
  });
});
