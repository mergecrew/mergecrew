/**
 * End-to-end orchestrator test for the V2.ae careful flow (#352).
 *
 * Exercises the full planner → coder → reviewer chain with two
 * reviewer-driven loop-back rounds and a third rejection that trips
 * REVIEW_LOOP_EXHAUSTED. We don't run the agent loop here — we drive
 * the orchestrator directly by calling `startWorkflow` and
 * `onStepReply` while marking the synthesized agent_steps as done
 * with realistic outputs.
 *
 * What this catches:
 *   - The careful branch in `startWorkflow` (project.graphProfile)
 *   - `dispatchGraphNext` advancing planner → coder → reviewer
 *   - Reviewer verdict routing (approve / requestChanges)
 *   - The loop-back round counter capping at REVIEW_LOOP_CAP=3
 *   - REVIEW_LOOP_EXHAUSTED emitted with the reviewer's last
 *     requestedChanges payload, and the workflow advancing through
 *     to RUN_COMPLETED rather than spinning forever
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import IORedis from 'ioredis';
import { Queue } from 'bullmq';
import pino from 'pino';
import { buildClientForUrl } from '@mergecrew/db';
import { Orchestrator } from '../src/orchestrator.js';
import type { Eventlog } from '@mergecrew/eventlog';

const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';
const TEST_PREFIX = `careful-test-${Date.now()}`;

const prisma = buildClientForUrl(process.env.DATABASE_URL ?? '');
const conn = new IORedis(REDIS_URL, { maxRetriesPerRequest: null });

interface RecordedEvent {
  type: string;
  payload?: Record<string, unknown>;
  agentStepId?: string | null;
}
const recorded: RecordedEvent[] = [];
const eventlog = {
  emit: async (e: { type: string; payload?: any; agentStepId?: string | null }) => {
    recorded.push({ type: e.type, payload: e.payload, agentStepId: e.agentStepId ?? null });
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
  runId: string;
  workflowRunId: string;
  workflowId: string;
}

async function seedCarefulRun(slugSuffix: string): Promise<Seed> {
  const org = await prisma.organization.create({
    data: { slug: `${TEST_PREFIX}-${slugSuffix}`, name: `Careful Test ${slugSuffix}` },
  });
  await prisma.runnerProfile.create({
    data: { organizationId: org.id, kind: 'instance_builtin' },
  });
  const project = await prisma.project.create({
    data: {
      organizationId: org.id,
      slug: 'p',
      name: 'P',
      // The whole point of this test.
      graphProfile: 'careful',
    },
  });
  // Lifecycle with one workflow. The careful branch ignores wf.agents
  // when picking the entry node — it always starts with planner.
  const lifecycle = await prisma.lifecycle.create({
    data: {
      organizationId: org.id,
      projectId: project.id,
      version: 1,
      sourceYaml: '',
      parsed: {
        lifecycle: { workflows: [{ id: 'wf-1', agents: [], out: [] }] },
        agents: {},
      } as any,
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
  return {
    organizationId: org.id,
    projectId: project.id,
    runId: run.id,
    workflowRunId: '',
    workflowId: 'wf-1',
  };
}

/**
 * Find the just-dispatched step. In a careful flow there is at most
 * one pending step at a time (the chain runs sequentially), so the
 * pending row is unambiguous. agent_steps has no createdAt, and
 * startedAt is only set by the runner, so neither is reliable for
 * "most recently inserted."
 */
async function findLatestStep(workflowRunId: string) {
  return prisma.agentStep.findFirst({
    where: { workflowRunId, status: 'pending' },
  });
}

/**
 * Drive a step from pending → done with the given output and trigger
 * onStepReply so the orchestrator's chain dispatch picks up the next
 * graph node. Mirrors what the runner does in production.
 */
async function completeStep(seed: Seed, stepId: string, output: unknown) {
  await prisma.agentStep.update({
    where: { id: stepId },
    data: { status: 'done', finishedAt: new Date(), output: output as any },
  });
  await orchestrator.onStepReply({
    organizationId: seed.organizationId,
    projectId: seed.projectId,
    runId: seed.runId,
    workflowRunId: seed.workflowRunId,
    stepId,
    outcome: { kind: 'completed', output },
  });
}

async function cleanupOrg(organizationId: string) {
  await prisma.runPause.deleteMany({ where: { organizationId } });
  await prisma.agentStep.deleteMany({ where: { organizationId } });
  await prisma.workflowRun.deleteMany({ where: { organizationId } });
  await prisma.dailyRun.deleteMany({ where: { organizationId } });
  await prisma.lifecycle.deleteMany({ where: { organizationId } });
  await prisma.project.deleteMany({ where: { organizationId } });
  await prisma.organization.delete({ where: { id: organizationId } });
}

const seeds: Seed[] = [];

beforeAll(async () => {
  // V2.af queue rename (ADR-0005). Purge both names — legacy kept by the
  // bridge worker for one release.
  for (const name of ['runner.step.instance', 'runner.step'] as const) {
    const runner = new Queue(name, { connection: conn });
    await runner.obliterate({ force: true }).catch(() => {});
    await runner.close();
  }
});

afterAll(async () => {
  for (const s of seeds) {
    await cleanupOrg(s.organizationId).catch(() => {});
  }
  await prisma.$disconnect();
  await conn.quit();
});

describe('careful flow: planner → coder → reviewer → __end__ (happy path)', () => {
  it('chains through the three agents in order and ends on approve', async () => {
    const seed = await seedCarefulRun('happy');
    seeds.push(seed);
    recorded.length = 0;

    const wfrId = await orchestrator.startWorkflow(
      seed.organizationId,
      seed.projectId,
      seed.runId,
      seed.workflowId,
    );
    seed.workflowRunId = wfrId;

    const planner = await findLatestStep(wfrId);
    expect(planner?.agentKind).toBe('Planner');
    expect(planner?.graphNodeKey).toBe('planner');
    await completeStep(seed, planner!.id, { planMarkdown: '## Plan\n- Files to touch: x.ts' });

    const coder = await findLatestStep(wfrId);
    expect(coder?.agentKind).toBe('Coder');
    expect(coder?.graphNodeKey).toBe('coder');
    await completeStep(seed, coder!.id, null);

    const reviewer = await findLatestStep(wfrId);
    expect(reviewer?.agentKind).toBe('Reviewer');
    expect(reviewer?.graphNodeKey).toBe('reviewer');
    await completeStep(seed, reviewer!.id, {
      verdict: 'approve',
      reasoning: 'lgtm',
      requestedChanges: [],
    });

    // After the reviewer's approve verdict, the chain terminates and
    // the workflow advances. With wf.out = [] the run completes too.
    const wfrAfter = await prisma.workflowRun.findUnique({ where: { id: wfrId } });
    expect(wfrAfter?.status).toBe('done');

    // No re-dispatch beyond the three canonical steps.
    const allSteps = await prisma.agentStep.findMany({ where: { workflowRunId: wfrId } });
    expect(allSteps).toHaveLength(3);
  });
});

describe('careful flow: reviewer loop-back exhaustion (#349)', () => {
  it('caps the reviewer→coder loop at REVIEW_LOOP_CAP rounds and emits REVIEW_LOOP_EXHAUSTED', async () => {
    const seed = await seedCarefulRun('exhausted');
    seeds.push(seed);
    recorded.length = 0;

    const wfrId = await orchestrator.startWorkflow(
      seed.organizationId,
      seed.projectId,
      seed.runId,
      seed.workflowId,
    );
    seed.workflowRunId = wfrId;

    // Planner → done
    let step = await findLatestStep(wfrId);
    expect(step?.agentKind).toBe('Planner');
    await completeStep(seed, step!.id, { planMarkdown: '## Plan' });

    // Three rounds of coder→reviewer, all rejected
    const rejection = {
      verdict: 'request_changes',
      reasoning: 'still missing the unit test',
      requestedChanges: ['add a unit test for the new branch'],
    };
    for (let round = 1; round <= 3; round++) {
      step = await findLatestStep(wfrId);
      expect(step?.agentKind, `round ${round} expected coder`).toBe('Coder');
      await completeStep(seed, step!.id, null);

      step = await findLatestStep(wfrId);
      expect(step?.agentKind, `round ${round} expected reviewer`).toBe('Reviewer');
      await completeStep(seed, step!.id, rejection);
    }

    // The third reviewer's request_changes hits the loop-back cap.
    // We expect a REVIEW_LOOP_EXHAUSTED event with the reviewer's last
    // requestedChanges in the payload, and the workflow finishing.
    const exhausted = recorded.find((e) => e.type === 'REVIEW_LOOP_EXHAUSTED');
    expect(exhausted, 'REVIEW_LOOP_EXHAUSTED must fire after the 3rd rejection').toBeDefined();
    expect(exhausted!.payload?.cap).toBe(3);
    expect(exhausted!.payload?.coderRounds).toBe(3);
    expect(exhausted!.payload?.lastReviewerRequestedChanges).toEqual([
      'add a unit test for the new branch',
    ]);

    const wfrAfter = await prisma.workflowRun.findUnique({ where: { id: wfrId } });
    expect(wfrAfter?.status).toBe('done');

    // Exactly 7 steps: 1 planner + 3 coders + 3 reviewers. The third
    // reviewer's rejection short-circuits before dispatching a 4th
    // coder.
    const allSteps = await prisma.agentStep.findMany({ where: { workflowRunId: wfrId } });
    expect(allSteps).toHaveLength(7);
    expect(allSteps.filter((s) => s.agentKind === 'Coder')).toHaveLength(3);
    expect(allSteps.filter((s) => s.agentKind === 'Reviewer')).toHaveLength(3);
  });
});
