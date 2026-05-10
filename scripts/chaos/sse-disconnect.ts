#!/usr/bin/env tsx
/**
 * Chaos drill: SSE drop + reconnect + replay parity end-to-end.
 *
 * Builds on scripts/sse-replay-test.ts (#60) by adding the post-flight
 * assertion #61 covers visually: after the run completes, the union of
 * (events received by the surviving stream) + (events received after
 * Last-Event-ID reconnect) MUST equal the events the REST replay
 * endpoint returns. Any divergence is a real bug — the live stream
 * dropped or duplicated events the durable log knows about.
 *
 * Steps:
 *   1. Kick a manual run.
 *   2. Open one SSE connection. Capture events.
 *   3. After RECONNECT_AFTER_MS, kill the connection. Note the last
 *      event id seen.
 *   4. Reconnect with `?lastEventId=<id>` (the controller fallback the
 *      built-in EventSource needs because it can't set headers on
 *      construction).
 *   5. Wait for the run to reach a terminal status (or POLL_TIMEOUT_MS).
 *   6. Fetch /timeline (REST replay) and assert the set of event ids it
 *      returns equals the union of A1+A2.
 *
 * Usage:
 *
 *   API_URL=http://localhost:4000 ORG_SLUG=demo PROJECT_SLUG=acme \
 *   AUTH_TOKEN=$(...) \
 *     pnpm tsx scripts/chaos/sse-disconnect.ts
 */

interface SseEvent {
  id: string;
  type: string;
  occurredAt: string;
}

const API_URL = process.env.API_URL ?? 'http://localhost:4000';
const ORG_SLUG = required('ORG_SLUG');
const PROJECT_SLUG = required('PROJECT_SLUG');
const AUTH_TOKEN = required('AUTH_TOKEN');
const RECONNECT_AFTER_MS = Number(process.env.RECONNECT_AFTER_MS ?? 5_000);
const POLL_TIMEOUT_MS = Number(process.env.POLL_TIMEOUT_MS ?? 120_000);

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

class SseClient {
  private es?: EventSource;
  events: SseEvent[] = [];

  constructor(private label: string, private url: string) {}

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.es = new EventSource(this.url);
      this.es.addEventListener('timeline', (ev) => {
        try {
          const e = JSON.parse((ev as MessageEvent).data) as SseEvent;
          this.events.push(e);
        } catch {
          /* ignore */
        }
      });
      this.es.onopen = () => resolve();
      this.es.onerror = () => {
        if (this.es?.readyState === EventSource.CONNECTING) return;
        reject(new Error(`[${this.label}] SSE error`));
      };
    });
  }

  close(): void {
    this.es?.close();
  }
}

async function main() {
  console.log(`[sse-disconnect] target ${ORG_SLUG}/${PROJECT_SLUG} via ${API_URL}`);

  await fetchJson<unknown>(`/v1/orgs/${ORG_SLUG}/projects/${PROJECT_SLUG}/runs`, { method: 'POST' });
  await new Promise((r) => setTimeout(r, 1_500));
  const runs = await fetchJson<{ items: Array<{ id: string }> }>(
    `/v1/orgs/${ORG_SLUG}/projects/${PROJECT_SLUG}/runs?limit=1`,
  );
  const runId = runs.items[0]?.id;
  if (!runId) {
    console.error('FAIL: no run created');
    process.exit(1);
  }
  console.log(`[sse-disconnect] watching run ${runId}`);

  const streamUrl = `${API_URL}/v1/orgs/${ORG_SLUG}/projects/${PROJECT_SLUG}/runs/${runId}/timeline/stream`;

  const a = new SseClient('A', streamUrl);
  await a.start();
  await new Promise((r) => setTimeout(r, RECONNECT_AFTER_MS));
  const lastSeenId = a.events.at(-1)?.id;
  console.log(`[sse-disconnect] dropping A after ${a.events.length} events (last id=${lastSeenId})`);
  a.close();

  const reconnectUrl = lastSeenId
    ? `${streamUrl}?lastEventId=${encodeURIComponent(lastSeenId)}`
    : streamUrl;
  const b = new SseClient('A2', reconnectUrl);
  await b.start();

  // Wait for the run to settle (or hit timeout).
  const start = Date.now();
  while (Date.now() - start < POLL_TIMEOUT_MS) {
    await new Promise((r) => setTimeout(r, 2_000));
    const detail = await fetchJson<{ status: string }>(
      `/v1/orgs/${ORG_SLUG}/projects/${PROJECT_SLUG}/runs/${runId}`,
    );
    if (['done', 'completed', 'failed', 'cancelled'].includes(detail.status)) break;
  }
  // Brief settle for tail events to flush.
  await new Promise((r) => setTimeout(r, 1_500));
  b.close();

  const replay = await fetchJson<{ items: SseEvent[] }>(
    `/v1/orgs/${ORG_SLUG}/projects/${PROJECT_SLUG}/runs/${runId}/timeline`,
  );

  const liveUnion = new Set([...a.events, ...b.events].map((e) => e.id));
  const replaySet = new Set(replay.items.map((e) => e.id));

  // Replay must be a superset of live (durable log is the source of truth).
  const missingFromReplay = [...liveUnion].filter((id) => !replaySet.has(id));
  if (missingFromReplay.length > 0) {
    console.error(`FAIL: ${missingFromReplay.length} event(s) in live stream missing from REST replay`);
    console.error(missingFromReplay.slice(0, 10));
    process.exit(1);
  }

  // Live should include every replay event (no event the durable log knows
  // about was silently dropped from the stream).
  const missingFromLive = [...replaySet].filter((id) => !liveUnion.has(id));
  if (missingFromLive.length > 0) {
    console.error(`FAIL: ${missingFromLive.length} event(s) in REST replay missing from live (A+A2)`);
    console.error(missingFromLive.slice(0, 10));
    process.exit(1);
  }

  console.log(
    `OK: live A=${a.events.length}+A2=${b.events.length} ⇔ replay=${replay.items.length}; reconnect captured every event`,
  );
}

main().catch((err) => {
  console.error('[sse-disconnect] runtime error:', err);
  process.exit(1);
});
