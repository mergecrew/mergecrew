/**
 * Gate pause-and-resume regression test (V1.3 exit criterion, #9).
 *
 * Two bugs lived here before:
 *   1. `onStepReply({kind:'gated_reject'})` marked the step `failed` and
 *      advanced the workflow — the run never entered `paused_gate`, so
 *      a human approving later had nothing to resume.
 *   2. `resumeGate` updated `dailyRun` with `where: { id: { not: undefined },
 *      status: 'paused_gate' }`, which un-paused EVERY paused-gate run in
 *      the org rather than just the one tied to the approval. Worse, it
 *      never re-dispatched the step.
 *
 * This test seeds two parallel daily runs with their own approvals and
 * verifies both fixes:
 *   - `onStepReply({kind:'gate_pending'})` flips run + step to `paused_gate`
 *     without advancing the workflow.
 *   - `resumeGate(approvalId, 'approve')` only un-pauses the matching run
 *     and pushes the step back onto the runner queue.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import IORedis from 'ioredis';
import { Queue, QueueEvents } from 'bullmq';
import pino from 'pino';
import { PrismaClient } from '@prisma/client';
import { makePgAdapter } from '@mergecrew/db';
import { Orchestrator } from '../src/orchestrator.js';
import type { Eventlog } from '@mergecrew/eventlog';

const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';
const TEST_PREFIX = `orch-test-${Date.now()}`;

const prisma = new PrismaClient({ adapter: makePgAdapter() });
const conn = new IORedis(REDIS_URL, { maxRetriesPerRequest: null });
const eventlogStub = {
  emit: async () => undefined,
} as unknown as Eventlog;
const orchestrator = new Orchestrator({
  connection: conn,
  eventlog: eventlogStub,
  logger: pino({ level: 'silent' }),
});

interface Seed {
  organizationId: string;
  projectId: string;
  lifecycleId: string;
  runId: string;
  workflowRunId: string;
  stepId: string;
  approvalId: string;
}

async function seedRun(slugSuffix: string): Promise<Seed> {
  const org = await prisma.organization.create({
    data: { slug: `${TEST_PREFIX}-${slugSuffix}`, name: `Orch Test ${slugSuffix}` },
  });
  await prisma.runnerProfile.create({
    data: { organizationId: org.id, kind: 'instance_builtin' },
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
      status: 'running',
      input: { agentRef: 'discovery' } as any,
    },
  });
  const approval = await prisma.approvalRequest.create({
    data: {
      organizationId: org.id,
      projectId: project.id,
      workflowRunId: wfr.id,
      reason: 'sensitive_path',
      details: {} as any,
      requiredRole: 'operator',
    },
  });
  return {
    organizationId: org.id,
    projectId: project.id,
    lifecycleId: lifecycle.id,
    runId: run.id,
    workflowRunId: wfr.id,
    stepId: step.id,
    approvalId: approval.id,
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

beforeAll(async () => {
  // Clear out the runner queue so this test's enqueues are observable.
  // V2.af renamed `runner.step` to `runner.step.instance` (ADR-0005);
  // legacy queue purged for free since CI shares the redis instance
  // with the runner's bridge worker.
  const runner = new Queue('runner.step.instance', { connection: conn });
  await runner.obliterate({ force: true }).catch(() => {});
  await runner.close();
  const legacy = new Queue('runner.step', { connection: conn });
  await legacy.obliterate({ force: true }).catch(() => {});
  await legacy.close();
});

afterAll(async () => {
  for (const s of seeds) {
    await cleanupOrg(s.organizationId).catch(() => {});
  }
  await prisma.$disconnect();
  await conn.quit();
});

describe('onStepReply gate_pending', () => {
  it('flips run + step to paused_gate and does not advance the workflow', async () => {
    const seed = await seedRun('gp-1');
    seeds.push(seed);

    // The runner persists the RunPause + ApprovalRequest before posting
    // the gate_pending outcome. Mirror that here.
    await prisma.runPause.create({
      data: {
        organizationId: seed.organizationId,
        dailyRunId: seed.runId,
        stepId: seed.stepId,
        kind: 'gate',
        approvalRequestId: seed.approvalId,
      },
    });

    await orchestrator.onStepReply({
      organizationId: seed.organizationId,
      projectId: seed.projectId,
      runId: seed.runId,
      workflowRunId: seed.workflowRunId,
      stepId: seed.stepId,
      outcome: { kind: 'gate_pending', approvalId: seed.approvalId },
    });

    const run = await prisma.dailyRun.findUnique({ where: { id: seed.runId } });
    const step = await prisma.agentStep.findUnique({ where: { id: seed.stepId } });
    const wfr = await prisma.workflowRun.findUnique({ where: { id: seed.workflowRunId } });
    expect(run?.status).toBe('paused_gate');
    expect(step?.status).toBe('paused_gate');
    // Workflow must not advance — leave it as-is. (Pre-fix code marked
    // the step `failed` and called maybeAdvanceWorkflow, which could
    // transition the wfr to `done` if the step was the last one.)
    expect(wfr?.status).toBe('running');
  });
});

describe('resumeGate(approve)', () => {
  it('only resumes the run tied to the approval — sibling paused_gate runs stay paused', async () => {
    const a = await seedRun('rg-a');
    const b = await seedRun('rg-b');
    seeds.push(a, b);

    // Pause both runs on their own approvals.
    for (const s of [a, b]) {
      await prisma.runPause.create({
        data: {
          organizationId: s.organizationId,
          dailyRunId: s.runId,
          stepId: s.stepId,
          kind: 'gate',
          approvalRequestId: s.approvalId,
        },
      });
      await prisma.dailyRun.update({ where: { id: s.runId }, data: { status: 'paused_gate' } });
      await prisma.agentStep.update({ where: { id: s.stepId }, data: { status: 'paused_gate' } });
    }

    // Watch the runner queue for the re-dispatched job. We can't just
    // `getWaitingCount()` because a local runner process may consume the
    // job before we observe it. `QueueEvents` lets us catch the `added`
    // hook regardless. V2.af: queue was renamed from `runner.step` to
    // `runner.step.instance` (ADR-0005) — trusted-org / instance-builtin
    // dispatch path lands here, which is what this test exercises.
    const events = new QueueEvents('runner.step.instance', { connection: conn.duplicate() });
    await events.waitUntilReady();
    let addedCount = 0;
    const seen = new Promise<void>((resolve) => {
      events.on('added', (job) => {
        if (job.name !== 'step') return;
        addedCount++;
        resolve();
      });
    });

    await orchestrator.resumeGate({ approvalId: a.approvalId, resolution: 'approve' });

    const runA = await prisma.dailyRun.findUnique({ where: { id: a.runId } });
    const runB = await prisma.dailyRun.findUnique({ where: { id: b.runId } });
    const stepA = await prisma.agentStep.findUnique({ where: { id: a.stepId } });
    expect(runA?.status).toBe('running');
    // The original bug flipped this one too. With the fix in place it
    // must stay paused.
    expect(runB?.status).toBe('paused_gate');
    // Step is back to pending so the runner can pick it up.
    expect(stepA?.status).toBe('pending');

    // Approve must re-dispatch the step.
    await Promise.race([
      seen,
      new Promise((_, reject) => setTimeout(() => reject(new Error('no step enqueued')), 2000)),
    ]);
    expect(addedCount).toBeGreaterThanOrEqual(1);

    const pause = await prisma.runPause.findFirst({
      where: { approvalRequestId: a.approvalId },
    });
    expect(pause?.resumedAt).not.toBeNull();
    await events.close();
  });
});
