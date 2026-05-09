#!/usr/bin/env tsx
/**
 * SSE multi-session + reconnect parity test (#60).
 *
 * Spec:
 *   1. Kick a run via POST /v1/orgs/:slug/projects/:project/runs
 *   2. Open two SSE connections to .../timeline/stream — both should
 *      receive the same events in the same order.
 *   3. Drop one connection mid-run, reconnect with Last-Event-ID = last
 *      seen, assert the missed events are replayed.
 *
 * Usage (manual; not yet wired into CI):
 *
 *   API_URL=http://localhost:4000 \
 *   ORG_SLUG=demo \
 *   PROJECT_SLUG=acme \
 *   AUTH_TOKEN=$(... bearer token ...) \
 *     pnpm tsx scripts/sse-replay-test.ts
 *
 * Exits non-zero if either: the two streams diverge, or the reconnect
 * misses any event the other stream saw. Times out after WAIT_MS if the
 * run doesn't produce events.
 */

interface SseEvent {
  id: string;
  type: string;
  occurredAt: string;
  payload?: unknown;
}

const API_URL = process.env.API_URL ?? 'http://localhost:4000';
const ORG_SLUG = required('ORG_SLUG');
const PROJECT_SLUG = required('PROJECT_SLUG');
const AUTH_TOKEN = required('AUTH_TOKEN');
const WAIT_MS = Number(process.env.WAIT_MS ?? 30_000);
const RECONNECT_AFTER_MS = Number(process.env.RECONNECT_AFTER_MS ?? 5_000);
const MIN_EVENTS = Number(process.env.MIN_EVENTS ?? 3);

function required(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`missing env var ${name}`);
    process.exit(2);
  }
  return v;
}

async function postRun(): Promise<string> {
  const r = await fetch(
    `${API_URL}/v1/orgs/${ORG_SLUG}/projects/${PROJECT_SLUG}/runs`,
    { method: 'POST', headers: { authorization: `Bearer ${AUTH_TOKEN}` } },
  );
  if (!r.ok) throw new Error(`runNow ${r.status}: ${await r.text()}`);
  const j = (await r.json()) as { id: string };
  return j.id;
}

class SseClient {
  private es?: EventSource;
  events: SseEvent[] = [];
  done = false;
  lastId?: string;

  constructor(private label: string, private url: string, lastEventId?: string) {
    this.lastId = lastEventId;
  }

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      // Bearer auth via fetch isn't possible from EventSource; we use the
      // `eventsource` polyfill semantics by sending Authorization via a
      // signed cookie in real deployments. In dev, the API also accepts
      // `x-mergecrew-user-id`. Use whichever the test environment supports.
      // Built-in EventSource accepts no headers, so this script targets
      // dev-mode auth via a query param fallback: pass `?token=` and
      // teach the controller to pick it up. For now, document the
      // limitation and require cookie-based auth in the host browser.
      this.es = new EventSource(this.url + (this.lastId ? `?lastEventId=${encodeURIComponent(this.lastId)}` : ''));
      this.es.addEventListener('timeline', (ev) => {
        try {
          const e = JSON.parse((ev as MessageEvent).data) as SseEvent;
          this.events.push(e);
          this.lastId = e.id;
        } catch {
          /* ignore */
        }
      });
      this.es.onopen = () => resolve();
      this.es.onerror = (err) => {
        // EventSource auto-reconnects on transient errors; only reject if
        // the stream hasn't opened yet.
        if (this.es?.readyState === EventSource.CONNECTING) return;
        reject(err);
      };
    });
  }

  close(): void {
    this.es?.close();
    this.done = true;
    console.log(`[${this.label}] closed; saw ${this.events.length} events`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  console.log(`kicking run on ${ORG_SLUG}/${PROJECT_SLUG} via ${API_URL}`);
  const runId = await postRun();
  console.log(`run ${runId} started`);

  const streamUrl = `${API_URL}/v1/orgs/${ORG_SLUG}/projects/${PROJECT_SLUG}/runs/${runId}/timeline/stream`;
  const a = new SseClient('A', streamUrl);
  const b = new SseClient('B', streamUrl);
  await Promise.all([a.start(), b.start()]);

  await sleep(RECONNECT_AFTER_MS);
  const dropAfterId = a.lastId;
  console.log(`dropping A after ${a.events.length} events (last id=${dropAfterId})`);
  a.close();

  // Wait for more events to flow.
  await sleep(WAIT_MS - RECONNECT_AFTER_MS);

  // Reconnect A with Last-Event-ID. Real Last-Event-ID is sent via header
  // by EventSource on auto-reconnect; native EventSource doesn't expose
  // a programmatic way to set it on construction, so we use the ?lastEventId=
  // query param the API also honors via a small change in the controller
  // (or accept that this is a manual-test approximation).
  const a2 = new SseClient('A2', streamUrl, dropAfterId);
  await a2.start();
  await sleep(2_000);
  a2.close();
  b.close();

  if (b.events.length < MIN_EVENTS) {
    console.error(`stream B saw only ${b.events.length} events (< ${MIN_EVENTS}); run too short to assert parity`);
    process.exit(3);
  }

  // Assertion 1: A1 ⊕ A2 should equal B (in order).
  const reassembled = [...a.events, ...a2.events];
  const orderOk = reassembled.every((e, i) => b.events[i] && b.events[i].id === e.id);
  if (!orderOk) {
    console.error('FAIL: A1+A2 events do not match B in order');
    console.error('A1+A2:', reassembled.map((e) => e.id));
    console.error('B:    ', b.events.map((e) => e.id));
    process.exit(1);
  }

  // Assertion 2: every event B saw after dropAfterId, A2 saw too (no gaps).
  const dropIdx = b.events.findIndex((e) => e.id === dropAfterId);
  if (dropIdx >= 0) {
    const missedOnB = b.events.slice(dropIdx + 1).map((e) => e.id);
    const seenByA2 = new Set(a2.events.map((e) => e.id));
    const gaps = missedOnB.filter((id) => !seenByA2.has(id));
    if (gaps.length > 0) {
      console.error(`FAIL: A2 missed ${gaps.length} events that B saw post-drop`);
      console.error('gaps:', gaps);
      process.exit(1);
    }
  }

  console.log(`OK: A=${a.events.length}+${a2.events.length} B=${b.events.length} — ordered parity + reconnect catchup`);
}

main().catch((err) => {
  console.error('runtime error:', err);
  process.exit(1);
});
