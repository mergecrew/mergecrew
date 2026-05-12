/**
 * Readiness probe for the Next.js web container (#317). Returns 200 only
 * when the upstream api responds to /healthz. The web container has no
 * direct DB/Redis access, so its readiness is really "can I serve a
 * page?" — which translates to "is the api reachable?".
 *
 * The check is bounded at 500ms so a hung api flips readiness inside
 * the kubelet's own deadline.
 */
export const dynamic = 'force-dynamic';

const READY_TIMEOUT_MS = 500;

export async function GET(): Promise<Response> {
  const apiBase = process.env.API_BASE_URL ?? 'http://api:4000';
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), READY_TIMEOUT_MS);
  try {
    const r = await fetch(`${apiBase}/healthz`, { signal: ctrl.signal });
    if (!r.ok) {
      return json(503, { status: 'degraded', checks: { api: 'fail' }, details: { api: `status ${r.status}` } });
    }
    return json(200, { status: 'ok', checks: { api: 'ok' } });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return json(503, { status: 'degraded', checks: { api: 'fail' }, details: { api: msg } });
  } finally {
    clearTimeout(timer);
  }
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}
