import { NextRequest } from 'next/server';
import { JWT_OVERRIDE_COOKIE } from '@/lib/session';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Runtime proxy from `/api/v1/*` on the web tier to `${API_BASE_URL}/v1/*`
 * on the API tier. Replaces the next.config.js `rewrites()` entry that
 * baked `process.env.API_BASE_URL` at build time — see
 * https://github.com/mergecrew/mergecrew/pull/487 for the bug repro.
 *
 * In Docker compose the web container needs `http://api:4000` but
 * `next build` runs without the env var set and freezes the localhost
 * default into the standalone rewrites manifest. A route handler reads
 * `process.env` per request so the image is portable across deploys.
 *
 * Streams the upstream body (SSE works), forwards headers, propagates
 * status. Hop-by-hop headers (`connection`, `transfer-encoding`,
 * `keep-alive`) are stripped on both directions per RFC 7230.
 */

const API_BASE = () => process.env.API_BASE_URL ?? 'http://localhost:4000';

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'host',
  'content-length',
]);

async function proxy(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  const { path } = await ctx.params;
  const target = new URL(`${API_BASE()}/v1/${path.join('/')}`);
  const incoming = new URL(req.url);
  incoming.searchParams.forEach((v, k) => target.searchParams.set(k, v));

  const headers = new Headers();
  req.headers.forEach((value, key) => {
    if (!HOP_BY_HOP.has(key.toLowerCase())) headers.set(key, value);
  });

  // The API authenticates via `Authorization: Bearer <jwt>` only — it
  // doesn't read cookies. Browser-initiated calls (EventSource for
  // `/timeline/stream`, client-component fetches) only send cookies, so
  // we translate the `mergecrew_jwt` cookie into a Bearer header before
  // forwarding. Don't overwrite an explicit Authorization header — API
  // keys (`mc_live_…`) and server-side `requireSession()` flows set it
  // directly and must pass through unchanged.
  if (!headers.has('authorization')) {
    const jwt = req.cookies.get(JWT_OVERRIDE_COOKIE)?.value;
    if (jwt) headers.set('authorization', `Bearer ${jwt}`);
  }

  const init: RequestInit = {
    method: req.method,
    headers,
    redirect: 'manual',
    // SSE + chunked uploads: forward the request body as a stream.
    // GET/HEAD have no body — node-fetch / undici rejects body on those.
    body: req.method === 'GET' || req.method === 'HEAD' ? undefined : req.body,
    // Undici-only flag needed when streaming a request body without
    // a content-length. Cast keeps the TS lib types happy across
    // node/undici versions.
    ...(req.method !== 'GET' && req.method !== 'HEAD' ? { duplex: 'half' } : {}),
  } as RequestInit;

  let upstream: Response;
  try {
    upstream = await fetch(target.toString(), init);
  } catch (err) {
    console.error(`Failed to proxy ${target}`, err);
    return new Response(`Upstream unreachable: ${(err as Error).message}`, { status: 502 });
  }

  const resHeaders = new Headers();
  upstream.headers.forEach((value, key) => {
    if (!HOP_BY_HOP.has(key.toLowerCase())) resHeaders.set(key, value);
  });

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: resHeaders,
  });
}

export const GET = proxy;
export const POST = proxy;
export const PUT = proxy;
export const PATCH = proxy;
export const DELETE = proxy;
export const HEAD = proxy;
export const OPTIONS = proxy;
