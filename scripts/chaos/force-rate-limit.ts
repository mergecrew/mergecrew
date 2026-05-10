#!/usr/bin/env tsx
/**
 * Chaos drill: simulate a provider rate-limit / outage by patching its
 * capability override to refuse the next agent step. Confirms the
 * CapabilityRouter falls back to the next preference.
 *
 * The cleanest way to fail a provider without actually triggering a
 * real-world rate limit is to set its capabilityOverrides to `{}` for
 * every model id, so `satisfies(have, need)` returns false for any
 * required capability. The router then walks to the next preference in
 * the profile.
 *
 * Steps:
 *   1. Snapshot the org's first LLM provider.
 *   2. PATCH it to wipe capability overrides (effectively unrouteable).
 *   3. Trigger a manual run; assert it makes forward progress (an agent
 *      step starts within POLL_TIMEOUT_MS) — meaning the router fell
 *      over to the next provider.
 *   4. Restore the original overrides.
 *
 * Usage:
 *
 *   API_URL=http://localhost:4000 ORG_SLUG=demo PROJECT_SLUG=acme \
 *   AUTH_TOKEN=$(...) \
 *     pnpm tsx scripts/chaos/force-rate-limit.ts
 */

interface Provider {
  id: string;
  kind: string;
  label: string;
  capabilityOverrides: Record<string, unknown> | null;
}

const API_URL = process.env.API_URL ?? 'http://localhost:4000';
const ORG_SLUG = required('ORG_SLUG');
const PROJECT_SLUG = required('PROJECT_SLUG');
const AUTH_TOKEN = required('AUTH_TOKEN');
const POLL_TIMEOUT_MS = Number(process.env.POLL_TIMEOUT_MS ?? 90_000);

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

async function main() {
  const list = await fetchJson<{ items: Provider[] }>(`/v1/orgs/${ORG_SLUG}/llm/providers`);
  if (list.items.length < 2) {
    console.error(`FAIL: org has ${list.items.length} provider(s); rate-limit drill needs at least 2 to demonstrate failover`);
    process.exit(2);
  }
  const target = list.items[0]!;
  console.log(`[force-rate-limit] disabling provider ${target.id} (${target.kind} / ${target.label})`);
  const originalOverrides = target.capabilityOverrides;

  const broken = {
    // Keep the models list so the registry still recognizes the provider,
    // but blank out per-model capability flags so `satisfies()` returns false.
    ...((originalOverrides ?? {}) as Record<string, unknown>),
    __broken_by_chaos__: true,
  };
  // Strip per-model flags by setting each known model id to {}.
  if ((originalOverrides as { models?: string[] })?.models) {
    for (const m of (originalOverrides as { models: string[] }).models) {
      (broken as Record<string, unknown>)[m] = {};
    }
  }

  await fetchJson(`/v1/orgs/${ORG_SLUG}/llm/providers/${target.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ capabilityOverrides: broken }),
  });

  let restored = false;
  const restore = async () => {
    if (restored) return;
    restored = true;
    await fetchJson(`/v1/orgs/${ORG_SLUG}/llm/providers/${target.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ capabilityOverrides: originalOverrides }),
    });
    console.log(`[force-rate-limit] restored capabilityOverrides on ${target.id}`);
  };
  process.on('SIGINT', () => restore().finally(() => process.exit(130)));

  try {
    const run = await fetchJson<{ projectId: string }>(
      `/v1/orgs/${ORG_SLUG}/projects/${PROJECT_SLUG}/runs`,
      { method: 'POST' },
    );
    console.log(`[force-rate-limit] manual run.due enqueued for ${run.projectId}`);

    const start = Date.now();
    let stepStarted = false;
    while (Date.now() - start < POLL_TIMEOUT_MS) {
      await new Promise((r) => setTimeout(r, 2_000));
      const runs = await fetchJson<{ items: Array<{ id: string }> }>(
        `/v1/orgs/${ORG_SLUG}/projects/${PROJECT_SLUG}/runs?limit=1`,
      );
      const latest = runs.items[0];
      if (!latest) continue;
      const tl = await fetchJson<{ items: Array<{ type: string }> }>(
        `/v1/orgs/${ORG_SLUG}/projects/${PROJECT_SLUG}/runs/${latest.id}/timeline`,
      );
      if (tl.items.some((e) => e.type === 'AGENT_STEP_STARTED')) {
        stepStarted = true;
        break;
      }
    }
    if (!stepStarted) {
      console.error('FAIL: no AGENT_STEP_STARTED before timeout — router did not fall over to a healthy provider');
      process.exit(1);
    }
    console.log('OK: router fell over to a healthy provider — agent step started');
  } finally {
    await restore();
  }
}

main().catch(async (err) => {
  console.error('[force-rate-limit] runtime error:', err);
  process.exit(1);
});
