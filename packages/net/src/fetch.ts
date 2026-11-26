import http from 'node:http';
import https from 'node:https';
import type { LookupFunction } from 'node:net';
import { PassThrough, Readable, Transform, pipeline } from 'node:stream';
import zlib from 'node:zlib';
import { classifyIp } from './ip.js';
import {
  normalizeHostname,
  resolveAndVet,
  UnsafeEgressError,
  type EgressOptions,
  type ResolvedAddress,
} from './policy.js';

/**
 * `safeFetch` — a fetch-compatible client for destinations that come from
 * tenants or from an LLM (Ollama endpoints, outbound webhooks, web skills).
 *
 * Differences from the global `fetch`:
 *
 *  - The hostname is resolved up-front and *every* returned address is
 *    vetted (see `resolveAndVet`): private, loopback, CGNAT, link-local,
 *    metadata, multicast, reserved and IPv4-mapped/embedded forms of those
 *    are refused unless the operator opted in.
 *  - The TCP connection is pinned to the vetted address via a custom
 *    `lookup`, so a second DNS answer (rebinding) can't redirect the
 *    socket. TLS still verifies against the original hostname (SNI).
 *  - Redirects are followed manually, one hop at a time, re-validating
 *    each `Location` (and calling `validateUrl`, if given) before
 *    connecting. `redirect: 'manual'` returns the 3xx response untouched.
 *  - A total timeout and a response-size ceiling are always applied.
 *  - Errors are `UnsafeEgressError` / `SafeFetchError` with generic,
 *    user-displayable messages; the detail is in `.reason` / `.code` /
 *    `.cause` for server-side logs.
 */

export interface SafeFetchOptions extends EgressOptions {
  /** Maximum redirect hops followed when `redirect` is `'follow'`. Default 5. */
  maxRedirects?: number;
  /**
   * Total time budget for the exchange, including reading the body.
   * Default 30s. `null` disables the internal timer (the caller's
   * `signal` still applies) — used for long-running LLM streams.
   */
  timeoutMs?: number | null;
  /** Ceiling on the decoded response body. Default 10 MiB. */
  maxResponseBytes?: number;
  /** Extra per-hop check (e.g. a project hostname allowlist). Throw to refuse. */
  validateUrl?: (url: URL) => void | Promise<void>;
}

export type SafeFetchErrorCode =
  | 'TIMEOUT'
  | 'TOO_MANY_REDIRECTS'
  | 'REDIRECT_NOT_ALLOWED'
  | 'RESPONSE_TOO_LARGE'
  | 'BAD_RESPONSE'
  | 'NETWORK';

const ERROR_MESSAGES: Record<SafeFetchErrorCode, string> = {
  TIMEOUT: 'request timed out',
  TOO_MANY_REDIRECTS: 'too many redirects',
  REDIRECT_NOT_ALLOWED: 'redirects are not allowed',
  RESPONSE_TOO_LARGE: 'response too large',
  BAD_RESPONSE: 'invalid response',
  NETWORK: 'request failed',
};

export class SafeFetchError extends Error {
  constructor(
    readonly code: SafeFetchErrorCode,
    options?: { cause?: unknown },
  ) {
    super(ERROR_MESSAGES[code], options);
    this.name = 'SafeFetchError';
  }
}

export const DEFAULT_MAX_RESPONSE_BYTES = 10 * 1024 * 1024;
export const DEFAULT_TIMEOUT_MS = 30_000;
export const DEFAULT_MAX_REDIRECTS = 5;

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const NULL_BODY_STATUSES = new Set([101, 103, 204, 205, 304]);

/**
 * A `net.connect` lookup that ignores the hostname and always returns the
 * pre-vetted address. Handles both the single-address and the
 * `{ all: true }` (happy-eyeballs) call shapes.
 */
export function pinnedLookup(pinned: ResolvedAddress): LookupFunction {
  return ((_hostname: string, options: unknown, callback: unknown) => {
    let cb = callback as (...args: unknown[]) => void;
    let o = options as { all?: boolean } | undefined;
    if (typeof options === 'function') {
      cb = options as (...args: unknown[]) => void;
      o = undefined;
    }
    if (o?.all) cb(null, [{ address: pinned.address, family: pinned.family }]);
    else cb(null, pinned.address, pinned.family);
  }) as LookupFunction;
}

type FetchInput = string | URL | Request;
type BodyInit = NonNullable<ConstructorParameters<typeof Response>[0]>;
type PipelineFn = (streams: ReadonlyArray<NodeJS.ReadableStream | NodeJS.WritableStream>, cb: (err: Error | null) => void) => void;

async function bodyToBuffer(
  body: unknown,
  headers: Headers,
): Promise<Buffer | null> {
  if (body === null || body === undefined) return null;
  if (typeof body === 'string') return Buffer.from(body, 'utf8');
  if (Buffer.isBuffer(body)) return body;
  if (body instanceof ArrayBuffer) return Buffer.from(body);
  if (ArrayBuffer.isView(body)) return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  // URLSearchParams / Blob / FormData / ReadableStream: let the platform
  // serialise it (and pick the content-type) by round-tripping a Request.
  const r = new Request('http://serialize.invalid/', {
    method: 'POST',
    body: body as BodyInit,
    duplex: 'half',
  } as RequestInit);
  const ct = r.headers.get('content-type');
  if (ct && !headers.has('content-type')) headers.set('content-type', ct);
  return Buffer.from(await r.arrayBuffer());
}

function sendOnce(
  url: URL,
  method: string,
  headers: Headers,
  body: Buffer | null,
  pinned: ResolvedAddress,
  signal: AbortSignal,
): Promise<http.IncomingMessage> {
  return new Promise((resolve, reject) => {
    const mod = url.protocol === 'https:' ? https : http;
    const hdrs: Record<string, string> = {};
    headers.forEach((v, k) => {
      if (k === 'host' || k === 'connection' || k === 'content-length' || k === 'transfer-encoding') return;
      hdrs[k] = v;
    });
    if (!headers.has('accept-encoding')) hdrs['accept-encoding'] = 'gzip, deflate, br';
    if (body) hdrs['content-length'] = String(body.length);
    else if (method === 'POST' || method === 'PUT' || method === 'PATCH') hdrs['content-length'] = '0';

    const host = normalizeHostname(url.hostname);
    const isLiteral = classifyIp(host).kind !== 'invalid';
    const req = mod.request(
      {
        protocol: url.protocol,
        // IP literals connect directly (Node skips `lookup` for them); use
        // the normalised vetted form so lenient spellings can't diverge.
        hostname: isLiteral ? pinned.address : host,
        port: url.port || undefined,
        path: `${url.pathname}${url.search}`,
        method,
        headers: hdrs,
        agent: false,
        lookup: pinnedLookup(pinned),
        signal,
      },
      resolve,
    );
    req.on('error', reject);
    if (body) req.end(body);
    else req.end();
  });
}

function decoderFor(encoding: string): Transform | null {
  switch (encoding) {
    case 'gzip':
    case 'x-gzip':
      return zlib.createGunzip();
    case 'deflate':
      return zlib.createInflate();
    case 'br':
      return zlib.createBrotliDecompress();
    default:
      return null;
  }
}

function sizeLimiter(maxBytes: number): Transform {
  let seen = 0;
  return new Transform({
    transform(chunk: Buffer, _enc, cb) {
      seen += chunk.length;
      if (seen > maxBytes) cb(new SafeFetchError('RESPONSE_TOO_LARGE'));
      else cb(null, chunk);
    },
  });
}

function toWebResponse(
  res: http.IncomingMessage,
  ctx: { url: URL; method: string; redirected: boolean; maxBytes: number; onDone: () => void },
): Response {
  const status = res.statusCode ?? 0;
  if (status < 200 || status > 599) {
    res.destroy();
    throw new SafeFetchError('BAD_RESPONSE');
  }
  const headers = new Headers();
  for (const [k, v] of Object.entries(res.headers)) {
    if (v === undefined) continue;
    try {
      if (Array.isArray(v)) for (const item of v) headers.append(k, item);
      else headers.set(k, v);
    } catch {
      // Drop header values the WHATWG Headers class rejects.
    }
  }

  const nullBody = ctx.method === 'HEAD' || NULL_BODY_STATUSES.has(status);
  if (nullBody) {
    res.resume();
    res.on('close', ctx.onDone);
    const r = new Response(null, { status, statusText: res.statusMessage ?? '', headers });
    return decorate(r, ctx);
  }

  const encoding = (headers.get('content-encoding') ?? '').trim().toLowerCase();
  const decoder = decoderFor(encoding);
  if (decoder) {
    headers.delete('content-encoding');
    headers.delete('content-length');
  } else {
    const declared = Number(headers.get('content-length') ?? NaN);
    if (Number.isFinite(declared) && declared > ctx.maxBytes) {
      res.destroy();
      throw new SafeFetchError('RESPONSE_TOO_LARGE');
    }
  }

  const out = new PassThrough();
  const stages: NodeJS.ReadWriteStream[] = [];
  if (decoder) stages.push(decoder);
  if (Number.isFinite(ctx.maxBytes)) stages.push(sizeLimiter(ctx.maxBytes));
  (pipeline as unknown as PipelineFn)([res, ...stages, out], (err) => {
    if (err) out.destroy(err);
    ctx.onDone();
  });
  out.on('close', ctx.onDone);

  const body = Readable.toWeb(out) as unknown as BodyInit;
  const r = new Response(body, { status, statusText: res.statusMessage ?? '', headers });
  return decorate(r, ctx);
}

function decorate(r: Response, ctx: { url: URL; redirected: boolean }): Response {
  try {
    Object.defineProperty(r, 'url', { value: ctx.url.href });
    Object.defineProperty(r, 'redirected', { value: ctx.redirected });
  } catch {
    // Cosmetic only.
  }
  return r;
}

/**
 * Fetch-compatible request to an untrusted destination. See module docs.
 * Throws `UnsafeEgressError` when the destination (or any redirect hop)
 * is refused, `SafeFetchError` for transport failures, and the signal's
 * abort reason when the caller aborts.
 */
export async function safeFetch(
  input: FetchInput,
  init: RequestInit = {},
  opts: SafeFetchOptions = {},
): Promise<Response> {
  let url: URL;
  let method: string;
  let headers: Headers;
  let body: Buffer | null;
  let signal: AbortSignal | null | undefined = init.signal;
  if (input instanceof Request) {
    url = new URL(input.url);
    method = (init.method ?? input.method ?? 'GET').toUpperCase();
    headers = new Headers(init.headers ?? input.headers);
    body =
      init.body !== undefined
        ? await bodyToBuffer(init.body, headers)
        : input.body
          ? Buffer.from(await input.arrayBuffer())
          : null;
    signal = init.signal ?? input.signal;
  } else {
    try {
      url = new URL(String(input));
    } catch {
      throw new UnsafeEgressError('hostname');
    }
    method = (init.method ?? 'GET').toUpperCase();
    headers = new Headers(init.headers);
    body = await bodyToBuffer(init.body, headers);
  }
  const redirectMode = init.redirect ?? 'follow';
  const maxRedirects = opts.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const maxBytes = opts.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  const timeoutMs = opts.timeoutMs === undefined ? DEFAULT_TIMEOUT_MS : opts.timeoutMs;

  if (signal?.aborted) throw signal.reason ?? new DOMException('The operation was aborted.', 'AbortError');

  const ac = new AbortController();
  const timer =
    timeoutMs !== null && Number.isFinite(timeoutMs)
      ? setTimeout(() => ac.abort(new SafeFetchError('TIMEOUT')), timeoutMs)
      : null;
  timer?.unref?.();
  const onOuterAbort = () => ac.abort(signal?.reason);
  signal?.addEventListener('abort', onOuterAbort, { once: true });
  let done = false;
  const cleanup = () => {
    if (done) return;
    done = true;
    if (timer) clearTimeout(timer);
    signal?.removeEventListener('abort', onOuterAbort);
  };

  let hops = 0;
  // Errors thrown by the caller's validateUrl hook propagate unchanged.
  let vetoError: unknown = undefined;
  try {
    for (;;) {
      if (opts.validateUrl) {
        try {
          await opts.validateUrl(url);
        } catch (e) {
          vetoError = e;
          throw e;
        }
      }
      const pinned = await resolveAndVet(url, opts);
      if (ac.signal.aborted) throw ac.signal.reason;
      const res = await sendOnce(url, method, headers, body, pinned, ac.signal);
      const status = res.statusCode ?? 0;

      if (REDIRECT_STATUSES.has(status) && redirectMode !== 'manual' && res.headers.location) {
        res.resume();
        res.destroy();
        if (redirectMode === 'error') throw new SafeFetchError('REDIRECT_NOT_ALLOWED');
        hops += 1;
        if (hops > maxRedirects) throw new SafeFetchError('TOO_MANY_REDIRECTS');
        let next: URL;
        try {
          next = new URL(res.headers.location, url);
        } catch {
          throw new SafeFetchError('BAD_RESPONSE');
        }
        if ((status === 303 && method !== 'HEAD') || ((status === 301 || status === 302) && method === 'POST')) {
          method = 'GET';
          body = null;
          for (const h of ['content-type', 'content-encoding', 'content-language', 'content-location']) {
            headers.delete(h);
          }
        }
        if (next.origin !== url.origin) {
          headers.delete('authorization');
          headers.delete('proxy-authorization');
          headers.delete('cookie');
        }
        url = next;
        continue;
      }

      return toWebResponse(res, { url, method, redirected: hops > 0, maxBytes, onDone: cleanup });
    }
  } catch (err) {
    cleanup();
    if (vetoError !== undefined && err === vetoError) throw err;
    if (err instanceof UnsafeEgressError || err instanceof SafeFetchError) throw err;
    if (ac.signal.aborted) {
      const reason: unknown = ac.signal.reason;
      if (reason instanceof SafeFetchError) throw reason;
      throw reason ?? new DOMException('The operation was aborted.', 'AbortError');
    }
    throw new SafeFetchError('NETWORK', { cause: err });
  }
}

/** Bind options into a `fetch`-shaped function (for SDKs that accept a custom fetch). */
export function createSafeFetch(opts: SafeFetchOptions = {}): typeof fetch {
  return ((input: FetchInput, init?: RequestInit) => safeFetch(input, init ?? {}, opts)) as typeof fetch;
}

/**
 * Read at most `maxBytes` of a response body, cancelling the rest. Use for
 * "return a preview of the page" style callers that want truncation
 * rather than an error.
 */
export async function readBodyLimited(
  res: Response,
  maxBytes: number,
): Promise<{ buffer: Buffer; truncated: boolean }> {
  const reader = res.body?.getReader();
  if (!reader) return { buffer: Buffer.alloc(0), truncated: false };
  const chunks: Buffer[] = [];
  let bytes = 0;
  let truncated = false;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value) continue;
      const remaining = maxBytes - bytes;
      if (value.byteLength > remaining) {
        if (remaining > 0) chunks.push(Buffer.from(value.subarray(0, remaining)));
        bytes = maxBytes;
        truncated = true;
        break;
      }
      chunks.push(Buffer.from(value));
      bytes += value.byteLength;
    }
  } finally {
    if (truncated) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  return { buffer: Buffer.concat(chunks), truncated };
}

/** Discard a response body without reading it. */
export async function discardBody(res: Response): Promise<void> {
  try {
    await res.body?.cancel();
  } catch {
    // ignore
  }
}

/**
 * Map any error from `safeFetch` to a short, generic, user-displayable
 * string. Never includes the URL, upstream status text or body.
 */
export function describeEgressError(err: unknown): string {
  if (err instanceof UnsafeEgressError) return err.message;
  if (err instanceof SafeFetchError) return err.message;
  if (err && typeof err === 'object' && (err as { name?: string }).name === 'AbortError') {
    return 'request aborted';
  }
  return 'request failed';
}
