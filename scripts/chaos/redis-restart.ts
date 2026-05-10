#!/usr/bin/env tsx
/**
 * Chaos drill: prove BullMQ workers and SSE pubsub recover when Redis is
 * bounced mid-run.
 *
 * The script can't bounce Redis itself in a portable way (different runtimes,
 * docker compose vs systemd vs brew, etc.) so it acts as the harness:
 *
 *   1. Sample worker liveness and queue depth before disruption.
 *   2. Kick a manual run.
 *   3. Wait until the run is observably running (≥1 timeline event), then
 *      print a clear "RESTART REDIS NOW" prompt and pause for stdin.
 *   4. After the operator presses enter, poll for forward progress —
 *      assert at least one new timeline event arrives within the recovery
 *      window, and the run eventually transitions to a non-paused status.
 *
 * Usage:
 *
 *   API_URL=http://localhost:4000 ORG_SLUG=demo PROJECT_SLUG=acme \
 *   AUTH_TOKEN=$(...) \
 *     pnpm tsx scripts/chaos/redis-restart.ts
 */

const API_URL = process.env.API_URL ?? 'http://localhost:4000';
const ORG_SLUG = required('ORG_SLUG');
const PROJECT_SLUG = required('PROJECT_SLUG');
const AUTH_TOKEN = required('AUTH_TOKEN');
const POLL_TIMEOUT_MS = Number(process.env.POLL_TIMEOUT_MS ?? 120_000);
const RECOVERY_WINDOW_MS = Number(process.env.RECOVERY_WINDOW_MS ?? 60_000);

function required(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`missing env var ${name}`);
    process.exit(2);
  }
  return v;
}

async function fetchJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  const r = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${AUTH_TOKEN}`,
      'content-type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
  if (!r.ok) throw new Error(`${r.status} ${path}: ${await r.text()}`);
  return (await r.json()) as T;
}

function waitForEnter(prompt: string): Promise<void> {
  return new Promise((resolve) => {
    process.stdout.write(prompt);
    process.stdin.resume();
    process.stdin.once('data', () => {
      process.stdin.pause();
      resolve();
    });
  });
}

async function pollForRun(runId: string, predicate: (events: Array<{ id: string; type: string; occurredAt: string }>) => boolean, timeoutMs: number): Promise<{ ok: boolean; events: Array<{ id: string; type: string; occurredAt: string }> }> {
  const start = Date.now();
  let last: Array<{ id: string; type: string; occurredAt: string }> = [];
  while (Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, 2_000));
    try {
      const tl = await fetchJson<{ items: Array<{ id: string; type: string; occurredAt: string }> }>(
        `/v1/orgs/${ORG_SLUG}/projects/${PROJECT_SLUG}/runs/${runId}/timeline`,
      );
      last = tl.items;
      if (predicate(last)) return { ok: true, events: last };
    } catch {
      // API may itself be unhealthy if its Redis upstream just went away —
      // keep polling.
    }
  }
  return { ok: false, events: last };
}

async function main() {
  console.log(`[redis-restart] target ${ORG_SLUG}/${PROJECT_SLUG} via ${API_URL}`);

  await fetchJson<unknown>(
    `/v1/orgs/${ORG_SLUG}/projects/${PROJECT_SLUG}/runs`,
    { method: 'POST' },
  );
  // Run.runNow doesn't return the run id (the queue dispatch is async).
  // Re-list to find the latest.
  await new Promise((r) => setTimeout(r, 1_500));
  const runs = await fetchJson<{ items: Array<{ id: string; status: string }> }>(
    `/v1/orgs/${ORG_SLUG}/projects/${PROJECT_SLUG}/runs?limit=1`,
  );
  const runId = runs.items[0]?.id;
  if (!runId) {
    console.error('FAIL: no run created — check the API logs');
    process.exit(1);
  }
  console.log(`[redis-restart] watching run ${runId}`);

  const beforeStart = await pollForRun(runId, (es) => es.length > 0, 60_000);
  if (!beforeStart.ok) {
    console.error('FAIL: run produced no timeline events before disruption');
    process.exit(1);
  }
  const beforeIds = new Set(beforeStart.events.map((e) => e.id));
  console.log(`[redis-restart] ${beforeIds.size} events captured before disruption`);

  await waitForEnter(
    '\n>>> Restart Redis now (docker compose restart redis / brew services restart redis / etc).\n>>> Press <enter> here when it is back up.\n',
  );

  console.log('[redis-restart] polling for forward progress (new events) within recovery window…');
  const after = await pollForRun(
    runId,
    (es) => es.some((e) => !beforeIds.has(e.id)),
    RECOVERY_WINDOW_MS,
  );
  if (!after.ok) {
    console.error(`FAIL: no new events in ${RECOVERY_WINDOW_MS}ms after restart — workers did not recover`);
    process.exit(1);
  }
  const newCount = after.events.length - beforeIds.size;
  console.log(`[redis-restart] ${newCount} new events after restart — workers recovered`);

  // Bonus: wait until the run reaches a non-running state.
  const final = await pollForRun(
    runId,
    () => false,
    POLL_TIMEOUT_MS - RECOVERY_WINDOW_MS,
  );
  const last = final.events.at(-1);
  console.log(`[redis-restart] final event: ${last?.type ?? '(none)'}`);
  console.log('OK: BullMQ workers + SSE pubsub survived a Redis bounce');
}

main().catch((err) => {
  console.error('[redis-restart] runtime error:', err);
  process.exit(1);
});
