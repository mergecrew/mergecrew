import http from 'node:http';
import type { AddressInfo } from 'node:net';
import zlib from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  createSafeFetch,
  describeEgressError,
  pinnedLookup,
  readBodyLimited,
  SafeFetchError,
  safeFetch,
} from '../src/fetch.js';
import { UnsafeEgressError, type Resolver } from '../src/policy.js';

/**
 * The test server binds to 127.0.0.1. Hostnames below are fake (`*.test`)
 * and are only reachable through the injected resolver, which proves the
 * connection used the pinned, vetted address rather than system DNS.
 */
let server: http.Server;
let port: number;
const hits: string[] = [];

beforeAll(async () => {
  delete process.env.MERGECREW_ALLOW_PRIVATE_EGRESS;
  delete process.env.MERGECREW_PRIVATE_EGRESS_ALLOW_HOSTS;
  server = http.createServer((req, res) => {
    hits.push(`${req.headers.host} ${req.method} ${req.url}`);
    const u = new URL(req.url ?? '/', 'http://x');
    switch (u.pathname) {
      case '/ok':
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('hello');
        return;
      case '/echo': {
        const chunks: Buffer[] = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              method: req.method,
              body: Buffer.concat(chunks).toString('utf8'),
              auth: req.headers.authorization ?? null,
            }),
          );
        });
        return;
      }
      case '/redirect':
        res.writeHead(302, { location: u.searchParams.get('to') ?? '/ok' });
        res.end();
        return;
      case '/redirect307':
        res.writeHead(307, { location: u.searchParams.get('to') ?? '/echo' });
        res.end();
        return;
      case '/loop':
        res.writeHead(302, { location: '/loop' });
        res.end();
        return;
      case '/big':
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('x'.repeat(10_000));
        return;
      case '/big-cl':
        res.writeHead(200, { 'content-type': 'text/plain', 'content-length': '10000' });
        res.end('x'.repeat(10_000));
        return;
      case '/gzip':
        res.writeHead(200, { 'content-type': 'text/plain', 'content-encoding': 'gzip' });
        res.end(zlib.gzipSync('compressed hello'));
        return;
      case '/bomb':
        res.writeHead(200, { 'content-type': 'text/plain', 'content-encoding': 'gzip' });
        res.end(zlib.gzipSync(Buffer.alloc(5_000_000)));
        return;
      case '/slow':
        setTimeout(() => {
          res.writeHead(200);
          res.end('late');
        }, 2_000);
        return;
      default:
        res.writeHead(404);
        res.end('nope');
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

/** Resolver that maps fake names to loopback; counts calls per host. */
function fakeResolver(map: Record<string, string[] | ((n: number) => string[])>) {
  const calls: Record<string, number> = {};
  const resolver: Resolver = async (host) => {
    calls[host] = (calls[host] ?? 0) + 1;
    const entry = map[host];
    if (!entry) throw new Error('ENOTFOUND');
    const addrs = typeof entry === 'function' ? entry(calls[host]!) : entry;
    return addrs.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
  };
  return { resolver, calls };
}

const base = (host: string, path: string) => `http://${host}:${port}${path}`;

describe('safeFetch', () => {
  it('blocks private destinations before connecting', async () => {
    const before = hits.length;
    const { resolver } = fakeResolver({});
    for (const url of [
      `http://127.0.0.1:${port}/ok`,
      `http://localhost:${port}/ok`,
      `http://[::1]:${port}/ok`,
      `http://[::ffff:127.0.0.1]:${port}/ok`,
      'http://169.254.169.254/latest/meta-data/',
      'http://0.0.0.0/',
    ]) {
      await expect(safeFetch(url, {}, { allowPrivate: false, allowPrivateHosts: [], resolver })).rejects.toBeInstanceOf(
        UnsafeEgressError,
      );
    }
    expect(hits.length).toBe(before);
  });

  it('pins the connection to the vetted address (DNS rebinding)', async () => {
    // First answer is the one we vet and connect to. Any later lookup —
    // which is what a rebinding attack relies on — would return an
    // unroutable address and the request would fail.
    const { resolver, calls } = fakeResolver({
      'rebind.test': (n) => (n === 1 ? ['127.0.0.1'] : ['10.255.255.1']),
    });
    const r = await safeFetch(base('rebind.test', '/ok'), {}, { allowPrivateHosts: ['rebind.test'], resolver });
    expect(r.status).toBe(200);
    expect(await r.text()).toBe('hello');
    expect(calls['rebind.test']).toBe(1);
    // Host header still names the original hostname.
    expect(hits.at(-1)).toContain(`rebind.test:${port}`);
  });

  it('refuses when a later resolution flips to a private address', async () => {
    // Same name, second request: resolution now answers 10.x and is refused.
    const { resolver } = fakeResolver({ 'flip.test': (n) => (n === 1 ? ['93.184.216.34'] : ['10.0.0.1']) });
    await resolver('flip.test');
    await expect(
      safeFetch('http://flip.test/ok', {}, { allowPrivate: false, allowPrivateHosts: [], resolver }),
    ).rejects.toBeInstanceOf(UnsafeEgressError);
  });

  it('pinnedLookup answers both lookup call shapes', () => {
    const lookup = pinnedLookup({ address: '93.184.216.34', family: 4 });
    const single = vi.fn();
    const all = vi.fn();
    (lookup as any)('ignored.example', {}, single);
    (lookup as any)('ignored.example', { all: true }, all);
    expect(single).toHaveBeenCalledWith(null, '93.184.216.34', 4);
    expect(all).toHaveBeenCalledWith(null, [{ address: '93.184.216.34', family: 4 }]);
  });

  describe('redirects', () => {
    it('re-validates every hop and refuses a redirect into private space', async () => {
      const { resolver } = fakeResolver({ 'a.test': ['127.0.0.1'] });
      const to = encodeURIComponent('http://169.254.169.254/latest/meta-data/');
      await expect(
        safeFetch(base('a.test', `/redirect?to=${to}`), {}, { allowPrivateHosts: ['a.test'], resolver }),
      ).rejects.toBeInstanceOf(UnsafeEgressError);
    });

    it('refuses a redirect to a hostname that resolves privately', async () => {
      const { resolver, calls } = fakeResolver({ 'a.test': ['127.0.0.1'], 'b.test': ['127.0.0.1'] });
      const to = encodeURIComponent(base('b.test', '/ok'));
      await expect(
        safeFetch(base('a.test', `/redirect?to=${to}`), {}, { allowPrivateHosts: ['a.test'], resolver }),
      ).rejects.toBeInstanceOf(UnsafeEgressError);
      expect(calls['b.test']).toBe(1);
    });

    it('follows allowed hops and runs validateUrl on each', async () => {
      const { resolver } = fakeResolver({ 'a.test': ['127.0.0.1'], 'b.test': ['127.0.0.1'] });
      const seen: string[] = [];
      const to = encodeURIComponent(base('b.test', '/ok'));
      const r = await safeFetch(
        base('a.test', `/redirect?to=${to}`),
        {},
        { allowPrivateHosts: ['a.test', 'b.test'], resolver, validateUrl: (u) => void seen.push(u.hostname) },
      );
      expect(r.status).toBe(200);
      expect(r.redirected).toBe(true);
      expect(seen).toEqual(['a.test', 'b.test']);
    });

    it('validateUrl can veto a hop', async () => {
      const { resolver } = fakeResolver({ 'a.test': ['127.0.0.1'], 'b.test': ['127.0.0.1'] });
      const to = encodeURIComponent(base('b.test', '/ok'));
      await expect(
        safeFetch(
          base('a.test', `/redirect?to=${to}`),
          {},
          {
            allowPrivateHosts: ['a.test', 'b.test'],
            resolver,
            validateUrl: (u) => {
              if (u.hostname === 'b.test') throw new UnsafeEgressError('hostname');
            },
          },
        ),
      ).rejects.toBeInstanceOf(UnsafeEgressError);
    });

    it('caps the number of hops', async () => {
      const { resolver } = fakeResolver({ 'a.test': ['127.0.0.1'] });
      const err = await safeFetch(base('a.test', '/loop'), {}, { allowPrivateHosts: ['a.test'], resolver, maxRedirects: 3 }).catch(
        (e) => e,
      );
      expect(err).toBeInstanceOf(SafeFetchError);
      expect(err.code).toBe('TOO_MANY_REDIRECTS');
    });

    it("redirect: 'manual' returns the 3xx without following", async () => {
      const { resolver } = fakeResolver({ 'a.test': ['127.0.0.1'] });
      const to = encodeURIComponent('http://169.254.169.254/');
      const r = await safeFetch(
        base('a.test', `/redirect?to=${to}`),
        { redirect: 'manual' },
        { allowPrivateHosts: ['a.test'], resolver },
      );
      expect(r.status).toBe(302);
    });

    it('drops credentials on cross-origin hops and keeps the body on 307', async () => {
      const { resolver } = fakeResolver({ 'a.test': ['127.0.0.1'], 'b.test': ['127.0.0.1'] });
      const to = encodeURIComponent(base('b.test', '/echo'));
      const r = await safeFetch(
        base('a.test', `/redirect307?to=${to}`),
        { method: 'POST', body: 'payload', headers: { authorization: 'Bearer secret' } },
        { allowPrivateHosts: ['a.test', 'b.test'], resolver },
      );
      const j = (await r.json()) as { method: string; body: string; auth: string | null };
      expect(j).toEqual({ method: 'POST', body: 'payload', auth: null });
    });
  });

  describe('limits', () => {
    const opts = () => ({ allowPrivateHosts: ['a.test'], resolver: fakeResolver({ 'a.test': ['127.0.0.1'] }).resolver });

    it('refuses up-front when content-length exceeds maxResponseBytes', async () => {
      const err = await safeFetch(base('a.test', '/big-cl'), {}, { ...opts(), maxResponseBytes: 1_000 }).catch((e) => e);
      expect(err).toBeInstanceOf(SafeFetchError);
      expect(err.code).toBe('RESPONSE_TOO_LARGE');
    });

    it('errors mid-stream when a chunked body exceeds maxResponseBytes', async () => {
      const r = await safeFetch(base('a.test', '/big'), {}, { ...opts(), maxResponseBytes: 1_000 });
      const err = await r.text().catch((e) => e);
      expect(err).toBeInstanceOf(SafeFetchError);
      expect(err.code).toBe('RESPONSE_TOO_LARGE');
    });

    it('applies the limit after decompression', async () => {
      const r = await safeFetch(base('a.test', '/bomb'), {}, { ...opts(), maxResponseBytes: 100_000 });
      await expect(r.arrayBuffer()).rejects.toThrow();
    });

    it('decodes gzip bodies', async () => {
      const r = await safeFetch(base('a.test', '/gzip'), {}, opts());
      expect(await r.text()).toBe('compressed hello');
      expect(r.headers.get('content-encoding')).toBeNull();
    });

    it('readBodyLimited truncates instead of failing', async () => {
      const r = await safeFetch(base('a.test', '/big'), {}, opts());
      const { buffer, truncated } = await readBodyLimited(r, 100);
      expect(buffer.length).toBe(100);
      expect(truncated).toBe(true);
    });

    it('times out with a generic error', async () => {
      const err = await safeFetch(base('a.test', '/slow'), {}, { ...opts(), timeoutMs: 100 }).catch((e) => e);
      expect(err).toBeInstanceOf(SafeFetchError);
      expect(err.code).toBe('TIMEOUT');
      expect(describeEgressError(err)).toBe('request timed out');
    });

    it('propagates caller aborts as AbortError', async () => {
      const ac = new AbortController();
      setTimeout(() => ac.abort(), 50);
      const err = await safeFetch(base('a.test', '/slow'), { signal: ac.signal }, opts()).catch((e) => e);
      expect(err.name).toBe('AbortError');
    });
  });

  it('createSafeFetch produces a fetch-compatible function', async () => {
    const f = createSafeFetch({ allowPrivateHosts: ['a.test'], resolver: fakeResolver({ 'a.test': ['127.0.0.1'] }).resolver });
    const r = await f(base('a.test', '/echo'), { method: 'POST', body: JSON.stringify({ a: 1 }) });
    expect(((await r.json()) as { body: string }).body).toBe('{"a":1}');
  });

  it('describeEgressError never echoes the destination', async () => {
    const err = await safeFetch('http://redis:6379/', {}, {
      allowPrivate: false,
      allowPrivateHosts: [],
      resolver: fakeResolver({ redis: ['172.18.0.2'] }).resolver,
    }).catch((e) => e);
    expect(describeEgressError(err)).not.toMatch(/redis|6379|172/);
  });
});
