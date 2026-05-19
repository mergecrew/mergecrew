import { describe, expect, it } from 'vitest';
import { isHostAllowed, parseAllowlistEnv, parseConnectTarget } from '../src/allowlist.js';

describe('isHostAllowed', () => {
  it('empty allowlist allows nothing', () => {
    expect(isHostAllowed('example.com', [])).toBe(false);
  });

  it('exact match allows the bare host (case-insensitive)', () => {
    expect(isHostAllowed('Api.GitHub.com', ['api.github.com'])).toBe(true);
  });

  it('wildcard matches strict subdomain only', () => {
    expect(isHostAllowed('files.pypi.org', ['*.pypi.org'])).toBe(true);
    expect(isHostAllowed('pypi.org', ['*.pypi.org'])).toBe(false);
  });

  it('* matches everything (still blocks loopback)', () => {
    expect(isHostAllowed('example.com', ['*'])).toBe(true);
    expect(isHostAllowed('localhost', ['*'])).toBe(false);
  });

  it('private ranges denied even when allowlist matches', () => {
    expect(isHostAllowed('10.0.0.5', ['*'])).toBe(false);
    expect(isHostAllowed('192.168.1.1', ['*'])).toBe(false);
    expect(isHostAllowed('172.20.5.1', ['*'])).toBe(false);
  });
});

describe('parseConnectTarget', () => {
  it('extracts host + port from a well-formed CONNECT line', () => {
    expect(parseConnectTarget('CONNECT api.github.com:443 HTTP/1.1')).toEqual({
      host: 'api.github.com',
      port: 443,
    });
  });

  it('accepts HTTP/1.0', () => {
    expect(parseConnectTarget('CONNECT a.example.com:8443 HTTP/1.0')).toEqual({
      host: 'a.example.com',
      port: 8443,
    });
  });

  it('returns null for malformed lines', () => {
    expect(parseConnectTarget('GET / HTTP/1.1')).toBeNull();
    expect(parseConnectTarget('CONNECT api.github.com HTTP/1.1')).toBeNull(); // no port
    expect(parseConnectTarget('CONNECT api.github.com:abc HTTP/1.1')).toBeNull();
    expect(parseConnectTarget('CONNECT api.github.com:99999 HTTP/1.1')).toBeNull(); // out-of-range
    expect(parseConnectTarget('')).toBeNull();
  });
});

describe('parseAllowlistEnv', () => {
  it('splits + trims + filters', () => {
    expect(parseAllowlistEnv(' a, b , ,c ')).toEqual(['a', 'b', 'c']);
    expect(parseAllowlistEnv(undefined)).toEqual([]);
  });
});
