// Server-side helpers for talking to the API. We pass the user's identity via
// a BFF trust token + the user's email. In V1 dev we accept simple bearer JWT.

import { notFound } from 'next/navigation';

const API_BASE = process.env.API_BASE_URL ?? 'http://localhost:4000';

export interface Session {
  userId: string;
  email: string;
  name?: string;
  jwt: string;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string | null;

  constructor(status: number, code: string | null, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

export function isApiNotFound(err: unknown): err is ApiError {
  return err instanceof ApiError && err.status === 404;
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
    const code = body?.error?.code ?? null;
    throw new ApiError(r.status, code, `API ${r.status}: ${code ?? r.statusText}`);
  }
  // Tolerate empty / 204 responses — NestJS serializes `null` returns as empty bodies.
  const text = await r.text();
  if (!text) return null as unknown as T;
  return JSON.parse(text) as T;
}

/**
 * `api()` variant for page-level fetches where a 404 from the API
 * means the addressed resource doesn't exist and the page should
 * render Next's not-found UI instead of bubbling up as a 500 (#435).
 *
 * Any non-404 error rethrows unchanged.
 */
export async function apiOr404<T>(
  path: string,
  init: RequestInit & { session?: Session } = {},
): Promise<T> {
  try {
    return await api<T>(path, init);
  } catch (err) {
    if (isApiNotFound(err)) notFound();
    throw err;
  }
}
