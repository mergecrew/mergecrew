import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  EgressBlocked,
  assertEgressAllowed,
  isHostAllowed,
  recordAndAssertEgress,
  skillFetch,
} from '../src/egress-policy.js';
import type { Resolver } from '@mergecrew/net';

/** Resolver stub: every name resolves to a public address. */
const pub = {
  egressResolver: (async () => [{ address: '93.184.216.34', family: 4 as const }]) as Resolver,
};
const resolveTo = (address: string): Resolver => async () => [
  { address, family: address.includes(':') ? 6 : 4 },
];

describe('isHostAllowed', () => {
  it('returns true when allowlist is undefined (back-compat)', () => {
    expect(isHostAllowed('example.com', undefined)).toBe(true);
    expect(isHostAllowed('example.com', null)).toBe(true);
  });

  it('blocks all when allowlist is empty', () => {
    expect(isHostAllowed('example.com', [])).toBe(false);
  });

  it('allows exact match', () => {
    expect(isHostAllowed('api.example.com', ['api.example.com'])).toBe(true);
    expect(isHostAllowed('other.com', ['api.example.com'])).toBe(false);
  });

  it('* allows everything (escape hatch)', () => {
    expect(isHostAllowed('arbitrary.example', ['*'])).toBe(true);
  });

  it('*.suffix matches strict subdomains only', () => {
    expect(isHostAllowed('foo.example.com', ['*.example.com'])).toBe(true);
    expect(isHostAllowed('a.b.example.com', ['*.example.com'])).toBe(true);
    // Bare `example.com` does NOT match `*.example.com`.
    expect(isHostAllowed('example.com', ['*.example.com'])).toBe(false);
    expect(isHostAllowed('badexample.com', ['*.example.com'])).toBe(false);
  });

  it('blocks loopback / private ranges even when a pattern would match', () => {
    expect(isHostAllowed('localhost', ['*'])).toBe(false);
    expect(isHostAllowed('127.0.0.1', ['*'])).toBe(false);
    expect(isHostAllowed('10.0.0.1', ['*'])).toBe(false);
    expect(isHostAllowed('192.168.1.1', ['*'])).toBe(false);
    expect(isHostAllowed('172.20.0.5', ['*'])).toBe(false);
    // Public ranges still pass.
    expect(isHostAllowed('1.1.1.1', ['*'])).toBe(true);
  });

  it('matches multiple patterns', () => {
    const list = ['github.com', '*.githubusercontent.com', 'api.example.com'];
    expect(isHostAllowed('github.com', list)).toBe(true);
    expect(isHostAllowed('raw.githubusercontent.com', list)).toBe(true);
    expect(isHostAllowed('api.example.com', list)).toBe(true);
    expect(isHostAllowed('evil.com', list)).toBe(false);
  });
});

describe('assertEgressAllowed', () => {
  it('passes for allowed URLs', () => {
    expect(() => assertEgressAllowed('https://api.example.com/x', ['api.example.com'])).not.toThrow();
  });

  it('throws EgressBlocked with the host on disallowed URLs', () => {
    expect(() => assertEgressAllowed('https://evil.com/x', ['api.example.com'])).toThrow(
      EgressBlocked,
    );
    try {
      assertEgressAllowed('https://evil.com/x', ['api.example.com']);
    } catch (e: any) {
      expect(e.code).toBe('EGRESS_BLOCKED');
      expect(e.message).toContain('evil.com');
    }
  });

  it('throws on unparseable URLs', () => {
    expect(() => assertEgressAllowed('not a url', ['*'])).toThrow(EgressBlocked);
  });

  it('does not throw when the allowlist is undefined', () => {
    expect(() => assertEgressAllowed('https://anything.example/x', undefined)).not.toThrow();
  });
});

describe('recordAndAssertEgress', () => {
  it('emits egress.checked with decision=allowed when the host passes', async () => {
    const emit = vi.fn().mockResolvedValue(undefined);
    await recordAndAssertEgress(
      'https://api.example.com/x',
      { egressAllowlist: ['api.example.com'], emit, ...pub },
      'web.fetch_url',
    );
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith('egress.checked', expect.objectContaining({
      source: 'skill',
      origin: 'web.fetch_url',
      host: 'api.example.com',
      decision: 'allowed',
      reason: 'allowlist',
    }));
  });

  it('emits decision=blocked and still throws when the host is not allowlisted', async () => {
    const emit = vi.fn().mockResolvedValue(undefined);
    await expect(
      recordAndAssertEgress(
        'https://evil.com/x',
        { egressAllowlist: ['api.example.com'], emit, ...pub },
        'web.fetch_url',
      ),
    ).rejects.toBeInstanceOf(EgressBlocked);
    expect(emit).toHaveBeenCalledWith('egress.checked', expect.objectContaining({
      decision: 'blocked',
      reason: 'unlisted',
      host: 'evil.com',
      origin: 'web.fetch_url',
    }));
  });

  it('flags loopback reason as loopback', async () => {
    const emit = vi.fn().mockResolvedValue(undefined);
    await expect(
      recordAndAssertEgress('http://127.0.0.1/x', { egressAllowlist: ['*'], emit, ...pub }, 'web.fetch_url'),
    ).rejects.toBeInstanceOf(EgressBlocked);
    expect(emit).toHaveBeenCalledWith('egress.checked', expect.objectContaining({
      decision: 'blocked',
      reason: 'loopback',
    }));
  });

  it('emits unrestricted when allowlist is undefined (back-compat)', async () => {
    const emit = vi.fn().mockResolvedValue(undefined);
    await recordAndAssertEgress(
      'https://api.example.com/x',
      { emit, ...pub },
      'web.fetch_url',
    );
    expect(emit).toHaveBeenCalledWith('egress.checked', expect.objectContaining({
      decision: 'allowed',
      reason: 'unrestricted',
    }));
  });

  it('swallows emit errors so audit logging never breaks the skill', async () => {
    const emit = vi.fn().mockRejectedValue(new Error('db down'));
    await expect(
      recordAndAssertEgress('https://api.example.com/x', { egressAllowlist: ['*'], emit, ...pub }, 'web.fetch_url'),
    ).resolves.toBeUndefined();
  });

  it('works without an emit (test contexts that build ctx by hand)', async () => {
    await expect(
      recordAndAssertEgress('https://api.example.com/x', { egressAllowlist: ['*'], ...pub }, 'web.fetch_url'),
    ).resolves.toBeUndefined();
  });
});

describe('null allowlist still blocks non-public destinations', () => {
  beforeEach(() => {
    delete process.env.MERGECREW_ALLOW_PRIVATE_EGRESS;
    delete process.env.MERGECREW_PRIVATE_EGRESS_ALLOW_HOSTS;
  });
  afterEach(() => {
    delete process.env.MERGECREW_ALLOW_PRIVATE_EGRESS;
    delete process.env.MERGECREW_PRIVATE_EGRESS_ALLOW_HOSTS;
  });

  const literals = [
    'http://169.254.169.254/latest/meta-data/',
    'http://[fd00:ec2::254]/',
    'http://metadata.google.internal/',
    'http://127.0.0.1:4000/',
    'http://localhost:4000/',
    'http://0.0.0.0/',
    'http://2130706433/',
    'http://0x7f.1/',
    'http://[::1]/',
    'http://[::ffff:127.0.0.1]/',
    'http://[::ffff:a9fe:a9fe]/',
    'http://100.64.0.1/',
    'http://10.0.0.1/',
    'http://[fe80::1]/',
  ];

  it.each(literals)('isHostAllowed(null) refuses %s', (url) => {
    const host = new URL(url).hostname;
    expect(isHostAllowed(host, null)).toBe(false);
    expect(isHostAllowed(host, undefined)).toBe(false);
    expect(isHostAllowed(host, ['*'])).toBe(false);
  });

  it.each(literals)('recordAndAssertEgress(null) refuses %s', async (url) => {
    const emit = vi.fn().mockResolvedValue(undefined);
    await expect(
      recordAndAssertEgress(url, { egressAllowlist: null, emit, ...pub }, 'web.fetch_url'),
    ).rejects.toBeInstanceOf(EgressBlocked);
    expect(emit).toHaveBeenCalledWith('egress.checked', expect.objectContaining({ decision: 'blocked' }));
  });

  it.each([
    ['redis', '172.18.0.5'],
    ['api', '10.0.0.7'],
    ['rebind.example.com', '127.0.0.1'],
    ['meta.example.com', '169.254.169.254'],
    ['v6.example.com', '::1'],
    ['mapped.example.com', '::ffff:192.168.0.1'],
    ['cgnat.example.com', '100.100.1.1'],
  ])('checks hostnames after resolution: %s → %s', async (host, address) => {
    const emit = vi.fn().mockResolvedValue(undefined);
    await expect(
      recordAndAssertEgress(
        `http://${host}/`,
        { egressAllowlist: null, emit, egressResolver: resolveTo(address) },
        'web.fetch_url',
      ),
    ).rejects.toBeInstanceOf(EgressBlocked);
    expect(emit).toHaveBeenCalledWith(
      'egress.checked',
      expect.objectContaining({ decision: 'blocked', host }),
    );
  });

  it('private opt-in only applies to hosts the project allowlists explicitly', async () => {
    process.env.MERGECREW_ALLOW_PRIVATE_EGRESS = '1';
    const ctx = (allowlist: string[] | null) => ({ egressAllowlist: allowlist, egressResolver: resolveTo('10.0.0.9') });
    await expect(recordAndAssertEgress('http://internal.corp/', ctx(['internal.corp']), 't')).resolves.toBeUndefined();
    await expect(recordAndAssertEgress('http://internal.corp/', ctx(null), 't')).rejects.toBeInstanceOf(EgressBlocked);
    await expect(recordAndAssertEgress('http://internal.corp/', ctx(['*']), 't')).rejects.toBeInstanceOf(EgressBlocked);
    // Metadata stays blocked even when listed.
    await expect(
      recordAndAssertEgress('http://169.254.169.254/', ctx(['169.254.169.254']), 't'),
    ).rejects.toBeInstanceOf(EgressBlocked);
  });
});

describe('skillFetch', () => {
  let server: http.Server;
  let port: number;
  beforeAll(async () => {
    server = http.createServer((req, res) => {
      if (req.url?.startsWith('/redirect')) {
        const to = new URL(req.url, 'http://x').searchParams.get('to')!;
        res.writeHead(302, { location: to });
        res.end();
        return;
      }
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(async () => {
    delete process.env.MERGECREW_ALLOW_PRIVATE_EGRESS;
    await new Promise<void>((r) => server.close(() => r()));
  });

  it('refuses a redirect hop to a host outside the allowlist', async () => {
    process.env.MERGECREW_ALLOW_PRIVATE_EGRESS = '1';
    const emit = vi.fn().mockResolvedValue(undefined);
    const to = encodeURIComponent('http://evil.example/');
    await expect(
      skillFetch(
        `http://site.test:${port}/redirect?to=${to}`,
        {},
        { egressAllowlist: ['site.test'], emit, egressResolver: resolveTo('127.0.0.1') },
        'web.fetch_url',
      ),
    ).rejects.toBeInstanceOf(EgressBlocked);
    expect(emit).toHaveBeenCalledWith(
      'egress.checked',
      expect.objectContaining({ decision: 'blocked', reason: 'unlisted', host: 'evil.example' }),
    );
  });

  it('refuses a redirect hop to a metadata address', async () => {
    process.env.MERGECREW_ALLOW_PRIVATE_EGRESS = '1';
    const to = encodeURIComponent('http://169.254.169.254/latest/meta-data/');
    await expect(
      skillFetch(
        `http://site.test:${port}/redirect?to=${to}`,
        {},
        { egressAllowlist: ['site.test', '169.254.169.254'], egressResolver: resolveTo('127.0.0.1') },
        'web.fetch_url',
      ),
    ).rejects.toBeInstanceOf(EgressBlocked);
  });

  it('fetches an allowed destination', async () => {
    process.env.MERGECREW_ALLOW_PRIVATE_EGRESS = '1';
    const r = await skillFetch(
      `http://site.test:${port}/`,
      {},
      { egressAllowlist: ['site.test'], egressResolver: resolveTo('127.0.0.1') },
      'web.fetch_url',
    );
    expect(await r.text()).toBe('ok');
  });

  it('refuses private destinations with a null allowlist even when the opt-in is set', async () => {
    process.env.MERGECREW_ALLOW_PRIVATE_EGRESS = '1';
    await expect(
      skillFetch(`http://site.test:${port}/`, {}, { egressAllowlist: null, egressResolver: resolveTo('127.0.0.1') }, 't'),
    ).rejects.toBeInstanceOf(EgressBlocked);
  });
});
