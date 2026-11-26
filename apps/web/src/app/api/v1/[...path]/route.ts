import { NextRequest } from 'next/server';
import { getSession } from '@/lib/session';
import {
  buildForwardHeaders,
  buildResponseHeaders,
  isPublicApiPath,
  safeApiPath,
} from '@/lib/api-proxy';

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
 * Streams the upstream body (SSE works), forwards an allowlist of request
 * headers (see `lib/api-proxy.ts`), propagates status. Hop-by-hop
 * response headers are stripped per RFC 7230. Path segments are validated
 * so the proxy can only ever reach `${API_BASE_URL}/v1/*`.
 */

const API_BASE = () => process.env.API_BASE_URL ?? 'http://localhost:4000';

async function proxy(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  const { path } = await ctx.params;
  // Reject anything that could escape `/v1/` (`..`, `.`, encoded
  // slashes/backslashes, double-encoding) instead of relying on an edge
  // proxy to filter it.
  const apiPath = safeApiPath(path ?? []);
  if (!apiPath) {
    return new Response('Bad request path', { status: 400 });
  }
  const target = new URL(`${API_BASE()}/v1/${apiPath}`);
  const incoming = new URL(req.url);
  incoming.searchParams.forEach((v, k) => target.searchParams.set(k, v));

  // Allowlisted request headers only: cookies and any client-supplied
  // identity headers (e.g. `x-mergecrew-user-id`) never reach the API.
  const headers = buildForwardHeaders(req.headers);

  // The API authenticates via `Authorization: Bearer <jwt>` only — it
  // doesn't read cookies. Browser-initiated calls (EventSource for
  // `/timeline/stream`, client-component fetches) only send cookies, so
  // we resolve the session server-side and synthesize the header.
  //
  // `getSession()` handles BOTH auth paths: the magic-link override
  // (`mergecrew_jwt` cookie) AND NextAuth (`next-auth.session-token`
  // cookie, encrypted, JWT lives in `token.mergecrewJwt`). Reading the
  // raw `mergecrew_jwt` cookie alone misses every OAuth user.
  //
  // Don't overwrite an explicit Authorization header — API keys
  // (`mc_live_…`) and server-side `requireSession()` flows set it
  // directly and must pass through unchanged.
  if (!headers.has('authorization')) {
    try {
      const session = await getSession();
      if (session?.jwt) headers.set('authorization', `Bearer ${session.jwt}`);
    } catch {
      // No session — handled below.
    }
  }

  // Unauthenticated requests are only relayed to explicitly public API
  // paths; everything else gets a local 401 without touching the API.
  if (!headers.has('authorization') && !isPublicApiPath(apiPath)) {
    return Response.json(
      { error: { code: 'UNAUTHORIZED', message: 'unauthorized' } },
      { status: 401 },
    );
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

  const resHeaders = buildResponseHeaders(upstream.headers);

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
