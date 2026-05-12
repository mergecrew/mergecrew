/**
 * Liveness probe for the Next.js web container (#317). Returns 200 as
 * long as the runtime is up. No I/O — kubelet uses this to decide
 * whether to restart the pod.
 */
export const dynamic = 'force-dynamic';

export function GET(): Response {
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}
