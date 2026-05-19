import { describe, expect, it, vi } from 'vitest';
import {
  EgressBlocked,
  assertEgressAllowed,
  isHostAllowed,
  recordAndAssertEgress,
} from '../src/egress-policy.js';

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
      { egressAllowlist: ['api.example.com'], emit },
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
        { egressAllowlist: ['api.example.com'], emit },
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

  it('flags loopback reason as private', async () => {
    const emit = vi.fn().mockResolvedValue(undefined);
    await expect(
      recordAndAssertEgress('http://127.0.0.1/x', { egressAllowlist: ['*'], emit }, 'web.fetch_url'),
    ).rejects.toBeInstanceOf(EgressBlocked);
    expect(emit).toHaveBeenCalledWith('egress.checked', expect.objectContaining({
      decision: 'blocked',
      reason: 'private',
    }));
  });

  it('emits unrestricted when allowlist is undefined (back-compat)', async () => {
    const emit = vi.fn().mockResolvedValue(undefined);
    await recordAndAssertEgress(
      'https://api.example.com/x',
      { emit },
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
      recordAndAssertEgress('https://api.example.com/x', { egressAllowlist: ['*'], emit }, 'web.fetch_url'),
    ).resolves.toBeUndefined();
  });

  it('works without an emit (test contexts that build ctx by hand)', async () => {
    await expect(
      recordAndAssertEgress('https://api.example.com/x', { egressAllowlist: ['*'] }, 'web.fetch_url'),
    ).resolves.toBeUndefined();
  });
});
