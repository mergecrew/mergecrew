#!/usr/bin/env tsx
/**
 * Chaos drill: force a budget-exhausted state and confirm the orchestrator
 * pauses runs cleanly instead of overspending.
 *
 * Steps:
 *   1. PATCH the org's daily budget to a value below today's spend.
 *   2. Trigger a manual run via POST /runs.
 *   3. Poll the run's timeline; assert a `RUN_PAUSED_BUDGET` event arrives
 *      and no `AGENT_STEP_STARTED` event after it.
 *   4. Restore the original budget so the operator's environment isn't
 *      left broken.
 *
 * Usage:
 *
 *   API_URL=http://localhost:4000 \
 *   ORG_SLUG=demo PROJECT_SLUG=acme \
 *   AUTH_TOKEN=$(...) \
 *     pnpm tsx scripts/chaos/budget-exhaust.ts
 *
 * Exits 0 on healthy pause, non-zero with a diagnostic on failure.
 */

interface BudgetInfo {
  dailyBudgetUsd: number | null;
  todaysSpendUsd: number;
}

const API_URL = process.env.API_URL ?? 'http://localhost:4000';
const ORG_SLUG = required('ORG_SLUG');
const PROJECT_SLUG = required('PROJECT_SLUG');
const AUTH_TOKEN = required('AUTH_TOKEN');
const POLL_TIMEOUT_MS = Number(process.env.POLL_TIMEOUT_MS ?? 60_000);

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
  if (!r.ok) {
    throw new Error(`${r.status} ${path}: ${await r.text()}`);
  }
  return (await r.json()) as T;
}

async function main() {
  console.log(`[budget-exhaust] target ${ORG_SLUG}/${PROJECT_SLUG} via ${API_URL}`);

  const before = await fetchJson<BudgetInfo>(`/v1/orgs/${ORG_SLUG}/budget`);
  console.log(`[budget-exhaust] current spend $${before.todaysSpendUsd.toFixed(4)}, cap ${before.dailyBudgetUsd ?? '(none)'}`);
  const newCap = Math.max(0, before.todaysSpendUsd) - 0.01;

  await fetchJson(`/v1/orgs/${ORG_SLUG}/budget`, {
    method: 'PATCH',
    body: JSON.stringify({ dailyBudgetUsd: Number(newCap.toFixed(4)) }),
  });
  console.log(`[budget-exhaust] cap pinched to $${newCap.toFixed(4)}`);

  let restored = false;
  const restore = async () => {
    if (restored) return;
    restored = true;
    await fetchJson(`/v1/orgs/${ORG_SLUG}/budget`, {
      method: 'PATCH',
      body: JSON.stringify({ dailyBudgetUsd: before.dailyBudgetUsd }),
    });
    console.log(`[budget-exhaust] cap restored to ${before.dailyBudgetUsd ?? '(none)'}`);
  };
  process.on('SIGINT', () => restore().finally(() => process.exit(130)));

  try {
    const run = await fetchJson<{ projectId: string; queued: boolean }>(
      `/v1/orgs/${ORG_SLUG}/projects/${PROJECT_SLUG}/runs`,
      { method: 'POST' },
    );
    console.log(`[budget-exhaust] run.due enqueued for ${run.projectId}`);

    const start = Date.now();
    let pausedSeen = false;
    let stepStartedAfterPause = false;
    while (Date.now() - start < POLL_TIMEOUT_MS) {
      await new Promise((r) => setTimeout(r, 2_000));
      const runs = await fetchJson<{ items: Array<{ id: string }> }>(
        `/v1/orgs/${ORG_SLUG}/projects/${PROJECT_SLUG}/runs?limit=1`,
      );
      const latest = runs.items[0];
      if (!latest) continue;
      const tl = await fetchJson<{ items: Array<{ type: string; occurredAt: string }> }>(
        `/v1/orgs/${ORG_SLUG}/projects/${PROJECT_SLUG}/runs/${latest.id}/timeline`,
      );
      let pauseAt: number | null = null;
      for (const e of tl.items) {
        if (e.type === 'RUN_PAUSED_BUDGET') {
          pausedSeen = true;
          pauseAt = new Date(e.occurredAt).getTime();
        } else if (
          pauseAt !== null &&
          e.type === 'AGENT_STEP_STARTED' &&
          new Date(e.occurredAt).getTime() > pauseAt
        ) {
          stepStartedAfterPause = true;
        }
      }
      if (pausedSeen) break;
    }

    if (!pausedSeen) {
      console.error('FAIL: no RUN_PAUSED_BUDGET event before timeout');
      process.exit(1);
    }
    if (stepStartedAfterPause) {
      console.error('FAIL: AGENT_STEP_STARTED fired after RUN_PAUSED_BUDGET — budget gate bypassed');
      process.exit(1);
    }
    console.log('OK: orchestrator paused on budget exhaustion and stayed paused');
  } finally {
    await restore();
  }
}

main().catch(async (err) => {
  console.error('[budget-exhaust] runtime error:', err);
  process.exit(1);
});
