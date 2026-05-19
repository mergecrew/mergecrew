import { describe, expect, it } from 'vitest';
import { isHostAllowed, parseAllowlistEnv } from '../src/allowlist.js';

describe('isHostAllowed', () => {
  it('empty allowlist allows nothing', () => {
    expect(isHostAllowed('example.com', [])).toBe(false);
  });

  it('exact match allows the bare host', () => {
    expect(isHostAllowed('api.github.com', ['api.github.com'])).toBe(true);
  });

  it('exact match is case-insensitive', () => {
    expect(isHostAllowed('Api.GITHUB.com', ['api.github.com'])).toBe(true);
  });

  it('wildcard matches strict subdomain only', () => {
    expect(isHostAllowed('files.pypi.org', ['*.pypi.org'])).toBe(true);
    expect(isHostAllowed('pypi.org', ['*.pypi.org'])).toBe(false);
    expect(isHostAllowed('files.pypi.org', ['*.PYPI.org'])).toBe(true);
  });

  it('strips trailing dot from FQDN', () => {
    expect(isHostAllowed('api.github.com.', ['api.github.com'])).toBe(true);
  });

  it('star alone allows everything (and still blocks loopback)', () => {
    expect(isHostAllowed('example.com', ['*'])).toBe(true);
    expect(isHostAllowed('localhost', ['*'])).toBe(false);
  });

  it('blocks RFC1918 / loopback even when a pattern would match', () => {
    expect(isHostAllowed('localhost', ['localhost'])).toBe(false);
    expect(isHostAllowed('127.0.0.1', ['127.0.0.1'])).toBe(false);
    expect(isHostAllowed('10.0.0.5', ['*'])).toBe(false);
    expect(isHostAllowed('192.168.1.1', ['*'])).toBe(false);
  });
});

describe('parseAllowlistEnv', () => {
  it('returns empty for undefined / empty', () => {
    expect(parseAllowlistEnv(undefined)).toEqual([]);
    expect(parseAllowlistEnv('')).toEqual([]);
    expect(parseAllowlistEnv('  ')).toEqual([]);
  });

  it('splits on commas and trims whitespace', () => {
    expect(parseAllowlistEnv('a.example.com, b.example.com,*.fastly.net')).toEqual([
      'a.example.com',
      'b.example.com',
      '*.fastly.net',
    ]);
  });

  it('drops empty entries from stray commas', () => {
    expect(parseAllowlistEnv(',foo,,bar,')).toEqual(['foo', 'bar']);
  });
});
