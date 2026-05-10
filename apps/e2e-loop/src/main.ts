#!/usr/bin/env tsx
/**
 * Full-loop end-to-end CI test (#191).
 *
 * Spawns a `DailyRun` against a configured project, polls until it reaches
 * a terminal state, and asserts on the resulting run / workflow / step
 * counts. Designed to run in CI against a real API + orchestrator + runner
 * with `MERGECREW_AGENT_STUB=1` set on the runner — the stub produces a
 * deterministic completed step (see `packages/agent-runtime/src/loop.ts`),
 * so every iteration of the test exercises the same orchestration plumbing
 * without an LLM dependency.
 *
 * Required env:
 *   MERGECREW_API_URL        — e.g. https://api.staging.mergecrew.dev
 *   MERGECREW_API_KEY        — `mc_live_…` Bearer token (operator role)
 *   MERGECREW_ORG_SLUG       — target organization slug
 *   MERGECREW_PROJECT_SLUG   — target project slug
 *
 * Optional env:
 *   MERGECREW_RUN_TIMEOUT_MS — ms to wait for the run to terminate (default 5 min)
 *   MERGECREW_POLL_MS        — ms between polls (default 5 s)
 *
 * Exit codes:
 *   0 — run completed and assertions passed
 *   1 — run failed or assertion mismatch (diagnostic on stderr)
 *   2 — config / env error
 */

const TERMINAL_STATUSES = new Set(['succeeded', 'success', 'failed', 'cancelled']);

interface RunRow {
  id: string;
  status: string;
  scheduledAt?: string;
  startedAt?: string | null;
  finishedAt?: string | null;
}

interface RunDetail {
  run: RunRow;
  workflows: Array<{
    id: string;
    workflowId: string;
    agentSteps: Array<{
      id: string;
      agentRef: string;
      status: string;
    }>;
  }>;
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`error: missing required env ${name}`);
    process.exit(2);
  }
  return v;
}

async function main(): Promise<void> {
  const apiUrl = requireEnv('MERGECREW_API_URL').replace(/\/$/, '');
  const apiKey = requireEnv('MERGECREW_API_KEY');
  const orgSlug = requireEnv('MERGECREW_ORG_SLUG');
  const projectSlug = requireEnv('MERGECREW_PROJECT_SLUG');
  const timeoutMs = Number(process.env.MERGECREW_RUN_TIMEOUT_MS ?? 5 * 60_000);
  const pollMs = Number(process.env.MERGECREW_POLL_MS ?? 5_000);

  const headers = {
    authorization: `Bearer ${apiKey}`,
    accept: 'application/json',
    'content-type': 'application/json',
  };
  const projectBase = `${apiUrl}/v1/orgs/${orgSlug}/projects/${projectSlug}`;

  // Step 1 — snapshot run ids that already exist so we can identify the
  // new one. The orchestrator processes 'run.due' jobs asynchronously, so
  // there's no synchronous "spawn" handle.
  console.log(`[e2e] snapshotting existing runs at ${projectBase}/runs`);
  const before = await listRuns(projectBase, headers);
  const beforeIds = new Set(before.map((r) => r.id));

  // Step 2 — enqueue.
  console.log(`[e2e] POST ${projectBase}/runs (queue run.due)`);
  const queueRes = await fetch(`${projectBase}/runs`, { method: 'POST', headers });
  if (!queueRes.ok) {
    console.error(`[e2e] queue failed: ${queueRes.status} ${await queueRes.text()}`);
    process.exit(1);
  }

  // Step 3 — wait for a new run id to appear.
  console.log(`[e2e] waiting for new DailyRun row (timeout ${timeoutMs}ms, poll ${pollMs}ms)`);
  const deadline = Date.now() + timeoutMs;
  let runId: string | null = null;
  while (Date.now() < deadline) {
    const cur = await listRuns(projectBase, headers);
    const fresh = cur.find((r) => !beforeIds.has(r.id));
    if (fresh) {
      runId = fresh.id;
      console.log(`[e2e] picked up run ${runId} (status=${fresh.status})`);
      break;
    }
    await sleep(pollMs);
  }
  if (!runId) {
    console.error('[e2e] FAIL: no new run materialized within the timeout');
    process.exit(1);
  }

  // Step 4 — poll the run to terminal.
  let lastStatus = '';
  while (Date.now() < deadline) {
    const r = await getJson<RunRow>(`${projectBase}/runs/${runId}`, headers);
    if (r.status !== lastStatus) {
      console.log(`[e2e] run status: ${r.status}`);
      lastStatus = r.status;
    }
    if (TERMINAL_STATUSES.has(r.status)) break;
    await sleep(pollMs);
  }
  if (!TERMINAL_STATUSES.has(lastStatus)) {
    console.error(`[e2e] FAIL: run ${runId} did not reach a terminal status (last=${lastStatus})`);
    process.exit(1);
  }

  // Step 5 — assert.
  const detail = await getJson<RunDetail>(`${projectBase}/runs/${runId}/full`, headers);
  const workflowCount = detail.workflows.length;
  const stepCount = detail.workflows.reduce((sum, w) => sum + w.agentSteps.length, 0);
  const completedSteps = detail.workflows.reduce(
    (sum, w) => sum + w.agentSteps.filter((s) => s.status === 'completed').length,
    0,
  );

  const failures: string[] = [];
  if (lastStatus === 'failed') failures.push(`run terminated as failed`);
  if (workflowCount === 0) failures.push('no workflows ran');
  if (stepCount === 0) failures.push('no agent steps ran');
  if (completedSteps === 0) failures.push('no agent step completed cleanly');

  if (failures.length > 0) {
    console.error('[e2e] FAIL:');
    for (const f of failures) console.error(`  - ${f}`);
    console.error(`[e2e]   run=${runId} workflows=${workflowCount} steps=${stepCount} completed=${completedSteps}`);
    process.exit(1);
  }

  console.log(
    `[e2e] OK    run=${runId} status=${lastStatus} workflows=${workflowCount} steps=${stepCount} completed=${completedSteps}`,
  );
}

async function listRuns(projectBase: string, headers: Record<string, string>): Promise<RunRow[]> {
  const data = await getJson<{ items: RunRow[] }>(`${projectBase}/runs?limit=10`, headers);
  return data.items ?? [];
}

async function getJson<T>(url: string, headers: Record<string, string>): Promise<T> {
  const r = await fetch(url, { headers });
  if (!r.ok) {
    throw new Error(`GET ${url} → ${r.status} ${await r.text()}`);
  }
  return (await r.json()) as T;
}

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, Math.max(0, ms)));
}

void main().catch((err) => {
  console.error(`[e2e] error: ${err?.stack ?? err}`);
  process.exit(1);
});
