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
    expect(cfg.tokens).toEqual(['mca_acme_ABC123']);
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
    expect(cfg.tokens).toEqual(['mca_test_XYZ']);
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

  it('collects repeated --token flags into tokens[]', () => {
    const cfg = resolveAgentConfig({
      argv: [
        '--token',
        'mca_a_ONE',
        '--token=mca_b_TWO',
        '--token',
        'mca_c_THREE',
        '--api-url',
        'https://x',
      ],
      env: {},
      hostname: HOST,
    });
    expect(cfg.tokens).toEqual(['mca_a_ONE', 'mca_b_TWO', 'mca_c_THREE']);
  });

  it('parses MERGECREW_AGENT_TOKENS as comma-separated list', () => {
    const cfg = resolveAgentConfig({
      argv: [],
      env: {
        MERGECREW_AGENT_TOKENS: ' mca_a_ONE , mca_b_TWO ,, mca_c_THREE ',
        MERGECREW_API_URL: 'https://x',
      },
      hostname: HOST,
    });
    expect(cfg.tokens).toEqual(['mca_a_ONE', 'mca_b_TWO', 'mca_c_THREE']);
  });

  it('CLI --token wins over both env vars', () => {
    const cfg = resolveAgentConfig({
      argv: ['--token', 'mca_cli_ONLY'],
      env: {
        MERGECREW_AGENT_TOKEN: 'mca_env_singular',
        MERGECREW_AGENT_TOKENS: 'mca_env_plural_a,mca_env_plural_b',
      },
      hostname: HOST,
    });
    expect(cfg.tokens).toEqual(['mca_cli_ONLY']);
  });

  it('MERGECREW_AGENT_TOKENS wins over legacy MERGECREW_AGENT_TOKEN', () => {
    const cfg = resolveAgentConfig({
      argv: [],
      env: {
        MERGECREW_AGENT_TOKEN: 'mca_legacy',
        MERGECREW_AGENT_TOKENS: 'mca_new_a,mca_new_b',
      },
      hostname: HOST,
    });
    expect(cfg.tokens).toEqual(['mca_new_a', 'mca_new_b']);
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
  it('throws if no tokens are present', () => {
    expect(() =>
      assertConfigUsable({
        tokens: [],
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
        tokens: ['t'],
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
        tokens: ['t'],
        apiUrl: 'not a url',
        name: 'n',
        driver: 'docker',
        dryRun: false,
        concurrency: 1,
      }),
    ).toThrow(/must be a URL/);
  });

  it('passes for a single-token config', () => {
    expect(() =>
      assertConfigUsable({
        tokens: ['t'],
        apiUrl: 'https://mergecrew.dev',
        name: 'n',
        driver: 'docker',
        dryRun: false,
        concurrency: 1,
      }),
    ).not.toThrow();
  });

  it('passes for a multi-token config', () => {
    expect(() =>
      assertConfigUsable({
        tokens: ['t1', 't2', 't3'],
        apiUrl: 'https://mergecrew.dev',
        name: 'n',
        driver: 'docker',
        dryRun: false,
        concurrency: 1,
      }),
    ).not.toThrow();
  });
});
