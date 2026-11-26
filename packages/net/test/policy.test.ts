import { describe, expect, it, vi } from 'vitest';
import {
  assertSafeUrl,
  privateEgressAllowedByEnv,
  privateEgressHostsFromEnv,
  resolveAndVet,
  UnsafeEgressError,
  type Resolver,
} from '../src/policy.js';

const resolverFor =
  (map: Record<string, string[]>): Resolver =>
  async (host) => {
    const addrs = map[host];
    if (!addrs) throw Object.assign(new Error(`ENOTFOUND ${host}`), { code: 'ENOTFOUND' });
    return addrs.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
  };

const deny = { allowPrivate: false, allowPrivateHosts: [] as string[] };

describe('resolveAndVet', () => {
  const blocked: Array<[string, Record<string, string[]>]> = [
    ['http://169.254.169.254/latest/meta-data/', {}],
    ['http://[fd00:ec2::254]/', {}],
    ['http://127.0.0.1:4000/', {}],
    ['http://2130706433/', {}],
    ['http://0x7f.1/', {}],
    ['http://[::1]/', {}],
    ['http://[::ffff:127.0.0.1]/', {}],
    ['http://[::ffff:a9fe:a9fe]/', {}],
    ['http://0.0.0.0:6379/', {}],
    ['http://10.0.0.1/', {}],
    ['http://100.64.1.1/', {}],
    ['http://localhost:4000/', {}],
    ['http://api.localhost/', {}],
    ['http://metadata.google.internal/', {}],
    ['http://redis:6379/', { redis: ['172.18.0.5'] }],
    ['http://api:4000/', { api: ['172.18.0.6'] }],
    ['http://ollama:11434/', { ollama: ['10.1.2.3'] }],
    ['http://rebind.example/', { 'rebind.example': ['127.0.0.1'] }],
    ['http://v6.example/', { 'v6.example': ['::1'] }],
    ['http://mapped.example/', { 'mapped.example': ['::ffff:10.0.0.1'] }],
    // Round-robin with one bad answer is refused outright.
    ['http://mixed.example/', { 'mixed.example': ['93.184.216.34', '10.0.0.1'] }],
    ['http://nxdomain.example/', {}],
    ['ftp://example.com/', { 'example.com': ['93.184.216.34'] }],
    ['file:///etc/passwd', {}],
    ['http://user:pass@example.com/', { 'example.com': ['93.184.216.34'] }],
  ];

  it.each(blocked)('refuses %s', async (url, map) => {
    await expect(resolveAndVet(new URL(url), { ...deny, resolver: resolverFor(map) })).rejects.toBeInstanceOf(
      UnsafeEgressError,
    );
  });

  it('accepts a public hostname and returns the vetted address to pin', async () => {
    const r = await resolveAndVet(new URL('https://example.com/x'), {
      ...deny,
      resolver: resolverFor({ 'example.com': ['93.184.216.34'] }),
    });
    expect(r).toEqual({ address: '93.184.216.34', family: 4 });
  });

  it('accepts public IP literals without resolving', async () => {
    const resolver = vi.fn();
    await expect(resolveAndVet(new URL('http://8.8.8.8/'), { ...deny, resolver })).resolves.toEqual({
      address: '8.8.8.8',
      family: 4,
    });
    expect(resolver).not.toHaveBeenCalled();
  });

  it('uses a generic message that does not echo the destination', async () => {
    const err = await resolveAndVet(new URL('http://redis:6379/'), {
      ...deny,
      resolver: resolverFor({ redis: ['172.18.0.5'] }),
    }).catch((e) => e);
    expect(err).toBeInstanceOf(UnsafeEgressError);
    expect(err.message).not.toMatch(/redis|172\.18|6379/);
    // Unresolvable and private destinations look the same to the caller.
    const nx = await resolveAndVet(new URL('http://nope.example/'), { ...deny, resolver: resolverFor({}) }).catch(
      (e) => e,
    );
    expect(nx.message).toBe(err.message);
  });

  describe('operator opt-in', () => {
    it('allowPrivate opens private/loopback/CGNAT but never metadata or link-local', async () => {
      const opts = {
        allowPrivate: true,
        allowPrivateHosts: [],
        resolver: resolverFor({ ollama: ['172.18.0.9'], meta: ['169.254.169.254'], ll: ['fe80::1'] }),
      };
      await expect(resolveAndVet(new URL('http://ollama:11434/'), opts)).resolves.toBeDefined();
      await expect(resolveAndVet(new URL('http://127.0.0.1:11434/'), opts)).resolves.toBeDefined();
      await expect(resolveAndVet(new URL('http://localhost:11434/'), opts)).rejects.toThrow(); // no resolver entry
      await expect(resolveAndVet(new URL('http://100.64.0.1/'), opts)).resolves.toBeDefined();
      await expect(resolveAndVet(new URL('http://meta/'), opts)).rejects.toBeInstanceOf(UnsafeEgressError);
      await expect(resolveAndVet(new URL('http://169.254.169.254/'), opts)).rejects.toBeInstanceOf(UnsafeEgressError);
      await expect(resolveAndVet(new URL('http://ll/'), opts)).rejects.toBeInstanceOf(UnsafeEgressError);
      await expect(resolveAndVet(new URL('http://0.0.0.0/'), opts)).rejects.toBeInstanceOf(UnsafeEgressError);
      await expect(resolveAndVet(new URL('http://metadata.google.internal/'), opts)).rejects.toBeInstanceOf(
        UnsafeEgressError,
      );
    });

    it('allowPrivateHosts opens only the named hosts', async () => {
      const opts = {
        allowPrivate: false,
        allowPrivateHosts: ['ollama'],
        resolver: resolverFor({ ollama: ['172.18.0.9'], redis: ['172.18.0.5'] }),
      };
      await expect(resolveAndVet(new URL('http://ollama:11434/'), opts)).resolves.toBeDefined();
      await expect(resolveAndVet(new URL('http://redis:6379/'), opts)).rejects.toBeInstanceOf(UnsafeEgressError);
    });

    it('allowPrivate can be decided per hostname', async () => {
      const opts = {
        allowPrivate: (h: string) => h === 'internal.example',
        allowPrivateHosts: [],
        resolver: resolverFor({ 'internal.example': ['10.0.0.2'], 'other.example': ['10.0.0.3'] }),
      };
      await expect(resolveAndVet(new URL('http://internal.example/'), opts)).resolves.toBeDefined();
      await expect(resolveAndVet(new URL('http://other.example/'), opts)).rejects.toBeInstanceOf(UnsafeEgressError);
    });
  });
});

describe('assertSafeUrl', () => {
  it('rejects unparsable URLs', async () => {
    await expect(assertSafeUrl('not a url', deny)).rejects.toBeInstanceOf(UnsafeEgressError);
  });
});

describe('env resolution', () => {
  it.each([
    [{ MERGECREW_ALLOW_PRIVATE_EGRESS: '1' }, true],
    [{ MERGECREW_ALLOW_PRIVATE_EGRESS: 'true', NODE_ENV: 'production' }, true],
    [{ MERGECREW_ALLOW_PRIVATE_EGRESS: '0', NODE_ENV: 'development' }, false],
    [{ NODE_ENV: 'development' }, true],
    [{ NODE_ENV: 'production' }, false],
    [{ NODE_ENV: 'test' }, false],
    [{}, false],
  ])('%j → %s', (env, expected) => {
    expect(privateEgressAllowedByEnv(env as NodeJS.ProcessEnv)).toBe(expected);
  });

  it('parses the private host list', () => {
    expect(
      privateEgressHostsFromEnv({ MERGECREW_PRIVATE_EGRESS_ALLOW_HOSTS: ' Ollama , ,models.internal.' } as NodeJS.ProcessEnv),
    ).toEqual(['ollama', 'models.internal']);
  });
});
