import { describe, expect, it } from 'vitest';
import {
  EgressBlocked,
  assertEgressAllowed,
  isHostAllowed,
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
