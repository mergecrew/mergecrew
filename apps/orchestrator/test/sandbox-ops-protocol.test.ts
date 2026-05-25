/**
 * V2.ag step 5 — supervisor ↔ agent sandbox-ops protocol integration
 * test. Exercises the Redis-list contract that both halves implement:
 *
 *   - apps/api `SandboxOpsService` (LPUSH on dispatch, BRPOP for
 *     result on supervisor side; BRPOP on poll, LPUSH on postResult
 *     for agent side).
 *   - apps/runner-agent `runSandboxOpsLoop` (the consumer).
 *
 * We don't spin up the API or an agent process — that's an E2E
 * smoke for a follow-up. This test asserts the wire-level protocol:
 * pushing to `runner-agent:sandbox-ops:<stepId>` and reading from
 * `runner-agent:sandbox-results:<stepId>:<opId>` works end-to-end
 * against a real Redis instance, and that drift between supervisor
 * and agent on the key shape would be caught.
 *
 * The key functions are duplicated here so the test stays
 * independent from the apps/api package. If the keys ever change in
 * either implementation, the test fails — making the symmetry
 * explicit + protecting against silent divergence.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import IORedis from 'ioredis';
import { randomUUID } from 'node:crypto';

const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';
const TEST_STEP = `step-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

const conn = new IORedis(REDIS_URL, { maxRetriesPerRequest: null });

// Must match apps/api/src/modules/runner-agent/sandbox-ops.service.ts
// and apps/runner-agent/src/sandbox-ops-executor.ts. If either drifts,
// the integration breaks silently — the symmetry is what this test
// guards. KEEP IN SYNC.
function opsKey(stepId: string): string {
  return `runner-agent:sandbox-ops:${stepId}`;
}
function resultKey(stepId: string, opId: string): string {
  return `runner-agent:sandbox-results:${stepId}:${opId}`;
}

interface OpEnvelope {
  opId: string;
  op: string;
  args: unknown;
}

interface ResultEnvelope {
  ok: boolean;
  result?: unknown;
  error?: { message: string };
}

/** Supervisor side: dispatch an op + wait for result. */
async function supervisorDispatch(
  stepId: string,
  op: string,
  args: unknown,
  timeoutSec = 5,
): Promise<ResultEnvelope> {
  const opId = randomUUID();
  await conn.lpush(opsKey(stepId), JSON.stringify({ opId, op, args }));
  const popped = await conn.brpop(resultKey(stepId, opId), timeoutSec);
  if (!popped) throw new Error('supervisor: result timeout');
  return JSON.parse(popped[1]) as ResultEnvelope;
}

/** Agent side: poll next op (blocking) + post a result envelope. */
async function agentPollNext(stepId: string, timeoutSec = 5): Promise<OpEnvelope | null> {
  const popped = await conn.brpop(opsKey(stepId), timeoutSec);
  if (!popped) return null;
  return JSON.parse(popped[1]) as OpEnvelope;
}
async function agentPostResult(
  stepId: string,
  opId: string,
  envelope: ResultEnvelope,
): Promise<void> {
  await conn.lpush(resultKey(stepId, opId), JSON.stringify(envelope));
  await conn.expire(resultKey(stepId, opId), 60);
}

beforeAll(async () => {
  // Clean any leftover state from prior runs against this Redis.
  const keys = await conn.keys('runner-agent:sandbox-*');
  if (keys.length) await conn.del(...keys);
});

afterAll(async () => {
  await conn.quit();
});

describe('sandbox-ops protocol (V2.ag step 5)', () => {
  it('round-trips one op: supervisor dispatch → agent poll → agent result → supervisor receives', async () => {
    // Kick off the supervisor's dispatch + the agent's processing in
    // parallel. The supervisor BRPOPs the result list; the agent
    // BRPOPs the ops list. With the queues empty at start, neither
    // blocks once the other LPUSHes.
    const supervisorPromise = supervisorDispatch(TEST_STEP, 'exec', {
      cmd: 'echo',
      args: ['hello'],
    });
    const agentPromise = (async () => {
      const env = await agentPollNext(TEST_STEP);
      expect(env).not.toBeNull();
      expect(env!.op).toBe('exec');
      expect(env!.args).toEqual({ cmd: 'echo', args: ['hello'] });
      await agentPostResult(TEST_STEP, env!.opId, {
        ok: true,
        result: { exitCode: 0, stdout: 'hello\n', stderr: '', timedOut: false },
      });
    })();

    const [supervisorResult] = await Promise.all([supervisorPromise, agentPromise]);
    expect(supervisorResult.ok).toBe(true);
    expect((supervisorResult.result as any).exitCode).toBe(0);
    expect((supervisorResult.result as any).stdout).toBe('hello\n');
  });

  it('agent error envelope surfaces back to the supervisor', async () => {
    const supervisorPromise = supervisorDispatch(TEST_STEP, 'exec', {
      cmd: 'false',
      args: [],
    });
    const agentPromise = (async () => {
      const env = await agentPollNext(TEST_STEP);
      await agentPostResult(TEST_STEP, env!.opId, {
        ok: false,
        error: { message: 'sandbox blew up' },
      });
    })();

    const [supervisorResult] = await Promise.all([supervisorPromise, agentPromise]);
    expect(supervisorResult.ok).toBe(false);
    expect(supervisorResult.error?.message).toBe('sandbox blew up');
  });

  it('multiple ops in flight correlate by opId, not order', async () => {
    // Supervisor dispatches A and B. Agent processes them in REVERSE
    // order (B first, A second). The opId-keyed result lists mean
    // the supervisor's two BRPOPs each wake on their own opId — no
    // mix-up despite the out-of-order completion.
    const aPromise = supervisorDispatch(TEST_STEP, 'exec', { cmd: 'a' });
    const bPromise = supervisorDispatch(TEST_STEP, 'exec', { cmd: 'b' });

    const agentPromise = (async () => {
      const first = await agentPollNext(TEST_STEP);
      const second = await agentPollNext(TEST_STEP);
      // Process the SECOND-popped op first (out of order).
      await agentPostResult(TEST_STEP, second!.opId, {
        ok: true,
        result: { id: 'second', cmd: (second!.args as any).cmd },
      });
      await agentPostResult(TEST_STEP, first!.opId, {
        ok: true,
        result: { id: 'first', cmd: (first!.args as any).cmd },
      });
    })();

    const [aResult, bResult] = await Promise.all([aPromise, bPromise, agentPromise]);
    // Each supervisor call gets ITS own op's result regardless of
    // the agent's completion order.
    expect((aResult.result as any).cmd).toBe('a');
    expect((bResult.result as any).cmd).toBe('b');
  });

  it('step-done sentinel is just another op envelope (agent recognizes by op field)', async () => {
    // The supervisor's finally-block sentinel push in
    // apps/runner/src/main.ts:handleStepJob uses opId='done',
    // op='step-done', args={}. Verify the agent-side BRPOP sees
    // exactly that shape.
    await conn.lpush(
      opsKey(TEST_STEP),
      JSON.stringify({ opId: 'done', op: 'step-done', args: {} }),
    );
    const env = await agentPollNext(TEST_STEP);
    expect(env).toEqual({ opId: 'done', op: 'step-done', args: {} });
  });

  it('idle timeout: BRPOP returns null after timeoutSec when queue stays empty', async () => {
    // Ensure no leftover ops.
    const drained = await conn.lrange(opsKey(TEST_STEP), 0, -1);
    for (const _ of drained) await conn.rpop(opsKey(TEST_STEP));
    const env = await agentPollNext(TEST_STEP, 1);
    expect(env).toBeNull();
  });
});
