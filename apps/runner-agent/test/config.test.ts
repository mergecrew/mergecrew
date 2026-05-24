import { describe, expect, it } from 'vitest';
import { resolveAgentConfig, tokenPrefix, assertConfigUsable } from '../src/config.js';

const HOST = () => 'fake-host';

describe('resolveAgentConfig', () => {
  it('reads required fields from flags', () => {
    const cfg = resolveAgentConfig({
      argv: [
        '--token',
        'mca_acme_ABC123',
        '--api-url',
        'https://mergecrew.dev',
        '--name',
        'homelab',
        '--driver',
        'process',
      ],
      env: {},
      hostname: HOST,
    });
    expect(cfg.token).toBe('mca_acme_ABC123');
    expect(cfg.apiUrl).toBe('https://mergecrew.dev');
    expect(cfg.name).toBe('homelab');
    expect(cfg.driver).toBe('process');
    expect(cfg.dryRun).toBe(false);
    expect(cfg.concurrency).toBe(1);
  });

  it('falls back to env when flags are absent', () => {
    const cfg = resolveAgentConfig({
      argv: [],
      env: {
        MERGECREW_AGENT_TOKEN: 'mca_test_XYZ',
        MERGECREW_API_URL: 'http://localhost:4000',
        MERGECREW_AGENT_NAME: 'envbox',
        MERGECREW_AGENT_DRIVER: 'docker',
        MERGECREW_AGENT_CONCURRENCY: '4',
      },
      hostname: HOST,
    });
    expect(cfg.token).toBe('mca_test_XYZ');
    expect(cfg.apiUrl).toBe('http://localhost:4000');
    expect(cfg.name).toBe('envbox');
    expect(cfg.driver).toBe('docker');
    expect(cfg.concurrency).toBe(4);
  });

  it('flags override env', () => {
    const cfg = resolveAgentConfig({
      argv: ['--name', 'flagname', '--driver=process'],
      env: { MERGECREW_AGENT_NAME: 'envname', MERGECREW_AGENT_DRIVER: 'docker' },
      hostname: HOST,
    });
    expect(cfg.name).toBe('flagname');
    expect(cfg.driver).toBe('process');
  });

  it('defaults name to hostname', () => {
    const cfg = resolveAgentConfig({ argv: [], env: {}, hostname: HOST });
    expect(cfg.name).toBe('fake-host');
  });

  it('rejects invalid driver', () => {
    expect(() =>
      resolveAgentConfig({
        argv: ['--driver', 'firecracker'],
        env: {},
        hostname: HOST,
      }),
    ).toThrow(/invalid --driver/);
  });

  it('--dry-run flag toggles dryRun', () => {
    const cfg = resolveAgentConfig({ argv: ['--dry-run'], env: {}, hostname: HOST });
    expect(cfg.dryRun).toBe(true);
  });
});

describe('tokenPrefix', () => {
  it('returns "<unset>" for empty token', () => {
    expect(tokenPrefix('')).toBe('<unset>');
  });
  it('returns the mca prefix when token matches the shape', () => {
    expect(tokenPrefix('mca_acme_ABC123XYZ')).toBe('mca_acme_ABC123');
  });
  it('falls back to a short masked view for other shapes', () => {
    expect(tokenPrefix('a-random-bearer-string')).toMatch(/^a-ra…ng$/);
  });
});

describe('assertConfigUsable', () => {
  it('throws if token is missing', () => {
    expect(() =>
      assertConfigUsable({
        token: '',
        apiUrl: 'https://x',
        name: 'n',
        driver: 'docker',
        dryRun: false,
        concurrency: 1,
      }),
    ).toThrow(/--token/);
  });

  it('throws if apiUrl is missing', () => {
    expect(() =>
      assertConfigUsable({
        token: 't',
        apiUrl: '',
        name: 'n',
        driver: 'docker',
        dryRun: false,
        concurrency: 1,
      }),
    ).toThrow(/--api-url/);
  });

  it('throws on a non-URL apiUrl', () => {
    expect(() =>
      assertConfigUsable({
        token: 't',
        apiUrl: 'not a url',
        name: 'n',
        driver: 'docker',
        dryRun: false,
        concurrency: 1,
      }),
    ).toThrow(/must be a URL/);
  });

  it('passes for a sensible config', () => {
    expect(() =>
      assertConfigUsable({
        token: 't',
        apiUrl: 'https://mergecrew.dev',
        name: 'n',
        driver: 'docker',
        dryRun: false,
        concurrency: 1,
      }),
    ).not.toThrow();
  });
});
