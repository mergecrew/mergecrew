// Server-side helpers for talking to the API. We pass the user's identity via
// a BFF trust token + the user's email. In V1 dev we accept simple bearer JWT.

const API_BASE = process.env.API_BASE_URL ?? 'http://localhost:4000';

export interface Session {
  userId: string;
  email: string;
  name?: string;
  jwt: string;
}

export async function api<T>(
  path: string,
  init: RequestInit & { session?: Session } = {},
): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.session) {
    headers.set('authorization', `Bearer ${init.session.jwt}`);
    headers.set('x-mergecrew-user-id', init.session.userId);
  }
  if (!headers.has('content-type') && init.body) {
    headers.set('content-type', 'application/json');
  }
  const r = await fetch(`${API_BASE}${path}`, { ...init, headers, cache: 'no-store' });
  if (!r.ok) {
    let body: any = null;
    try {
      body = await r.json();
    } catch {}
    throw new Error(`API ${r.status}: ${body?.error?.code ?? r.statusText}`);
  }
  // Tolerate empty / 204 responses — NestJS serializes `null` returns as empty bodies.
  const text = await r.text();
  if (!text) return null as unknown as T;
  return JSON.parse(text) as T;
}
