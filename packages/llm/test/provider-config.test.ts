import { describe, expect, it } from 'vitest';
import { ProviderUnavailableError } from '@mergecrew/domain';
import {
  buildChatModel,
  buildEmbeddingsModel,
  decodeBedrockCredential,
  encodeBedrockCredential,
  probeOllama,
  providerConfigFromRow,
  ProviderRegistry,
  OLLAMA_PROBE_FAILED,
} from '../src/index.js';

const creds = {
  accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  region: 'eu-west-1',
};

// Identity "encryption" for tests — the real callers pass the KMS envelope helpers.
const decrypt = (b: string) => b;

describe('Bedrock credentials', () => {
  it('round-trips encode → decode', () => {
    const blob = encodeBedrockCredential(creds);
    expect(decodeBedrockCredential(blob)).toEqual({
      region: 'eu-west-1',
      credentials: { accessKeyId: creds.accessKeyId, secretAccessKey: creds.secretAccessKey },
    });
  });

  it.each([
    [{ ...creds, accessKeyId: '' }],
    [{ ...creds, secretAccessKey: '' }],
    [{ ...creds, region: '' }],
    [{ ...creds, region: 'evil.example.com/' }],
    [{ ...creds, accessKeyId: 'not a key' }],
  ])('rejects incomplete or malformed input %#', (input) => {
    expect(() => encodeBedrockCredential(input)).toThrow();
  });

  it('decodes legacy / malformed blobs to null', () => {
    expect(decodeBedrockCredential(undefined)).toBeNull();
    expect(decodeBedrockCredential('some-old-api-key')).toBeNull();
    expect(decodeBedrockCredential('{"type":"aws-static","accessKeyId":"x"}')).toBeNull();
  });

  it('providerConfigFromRow maps the stored blob to explicit credentials + region', () => {
    const cfg = providerConfigFromRow(
      {
        id: 'p1',
        kind: 'bedrock',
        endpoint: null,
        credentialCiphertext: encodeBedrockCredential(creds),
        capabilityOverrides: { models: ['anthropic.claude-3-haiku-20240307-v1:0'] },
      },
      decrypt,
    );
    expect(cfg.awsRegion).toBe('eu-west-1');
    expect(cfg.awsCredentials?.accessKeyId).toBe(creds.accessKeyId);
    expect(cfg.apiKey).toBeUndefined();
    expect(cfg.models).toEqual(['anthropic.claude-3-haiku-20240307-v1:0']);
  });

  it('never treats a legacy single "API key" as Bedrock credentials', () => {
    const cfg = providerConfigFromRow(
      { id: 'p1', kind: 'bedrock', endpoint: null, credentialCiphertext: 'legacy-key', capabilityOverrides: null },
      decrypt,
    );
    expect(cfg.apiKey).toBeUndefined();
    expect(cfg.awsCredentials).toBeUndefined();
  });

  describe('fails closed without stored credentials', () => {
    const prev = { ...process.env };
    const ambient = () => {
      // Ambient credentials present on the host must not be picked up.
      process.env.AWS_ACCESS_KEY_ID = 'AKIAAMBIENTAMBIENT00';
      process.env.AWS_SECRET_ACCESS_KEY = 'ambient-secret-ambient-secret';
      process.env.BEDROCK_AWS_ACCESS_KEY_ID = 'AKIAAMBIENTAMBIENT00';
      process.env.BEDROCK_AWS_SECRET_ACCESS_KEY = 'ambient-secret-ambient-secret';
      process.env.AWS_REGION = 'us-east-1';
    };
    const restore = () => {
      for (const k of Object.keys(process.env)) if (!(k in prev)) delete process.env[k];
      Object.assign(process.env, prev);
    };

    it.each([
      ['no credentials', { id: 'b', kind: 'bedrock' as const, models: [] }],
      ['no region', { id: 'b', kind: 'bedrock' as const, models: [], awsCredentials: { accessKeyId: 'A', secretAccessKey: 'B' } }],
      ['region only', { id: 'b', kind: 'bedrock' as const, models: [], awsRegion: 'us-east-1' }],
    ])('%s → ProviderUnavailableError', (_label, cfg) => {
      ambient();
      try {
        expect(() => buildChatModel(cfg, 'anthropic.claude-3-haiku-20240307-v1:0')).toThrow(ProviderUnavailableError);
        expect(() => buildEmbeddingsModel(cfg, 'amazon.titan-embed-text-v2:0')).toThrow(ProviderUnavailableError);
        const reg = new ProviderRegistry([cfg]);
        expect(() => reg.buildModel('b', 'anthropic.claude-3-haiku-20240307-v1:0')).toThrow(/no AWS credentials/);
      } finally {
        restore();
      }
    });

    it('builds with the explicit per-provider credentials and region', async () => {
      ambient();
      try {
        const m = buildChatModel(
          {
            id: 'b',
            kind: 'bedrock',
            models: [],
            awsRegion: 'eu-west-1',
            awsCredentials: { accessKeyId: creds.accessKeyId, secretAccessKey: creds.secretAccessKey },
          },
          'anthropic.claude-3-haiku-20240307-v1:0',
        ) as any;
        expect(m.region).toBe('eu-west-1');
        const resolved = await m.client.config.credentials();
        expect(resolved.accessKeyId).toBe(creds.accessKeyId);
        expect(await m.client.config.region()).toBe('eu-west-1');
      } finally {
        restore();
      }
    });
  });
});

describe('probeOllama', () => {
  it.each([
    'http://169.254.169.254',
    'http://localhost:4000',
    'http://127.0.0.1:6379',
    'http://[::1]:11434',
    'http://0.0.0.0:11434',
    'http://10.0.0.1:11434',
  ])('refuses %s before any request, with a generic error', async (endpoint) => {
    const r = await probeOllama(endpoint, { egress: { allowPrivate: false, allowPrivateHosts: [] } });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).not.toContain(endpoint);
      expect(r.error).not.toMatch(/HTTP \d/);
    }
  });

  it('refuses hostnames that resolve privately', async () => {
    const r = await probeOllama('http://redis:6379', {
      egress: {
        allowPrivate: false,
        allowPrivateHosts: [],
        resolver: async () => [{ address: '172.18.0.4', family: 4 }],
      },
    });
    expect(r).toEqual({ ok: false, error: expect.not.stringContaining('redis') });
  });

  it('rejects unparsable endpoints generically', async () => {
    expect(await probeOllama('not a url')).toEqual({ ok: false, error: OLLAMA_PROBE_FAILED });
  });
});
