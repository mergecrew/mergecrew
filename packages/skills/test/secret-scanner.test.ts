import { afterEach, describe, expect, it } from 'vitest';
import {
  OutboundSecretError,
  SkillExecutor,
  __clearRegisteredSecretsForTests,
  assertNoSecrets,
  knownSecretValues,
  registerKnownSecret,
  scanText,
  scanValue,
  type AnySkill,
  type SkillExecutionContext,
} from '../src/index.js';

afterEach(() => __clearRegisteredSecretsForTests());

const env = {
  KMS_MASTER_KEY: 'f3a9c1d27be04e8a9c11d2e3f4a5b6c7',
  GITHUB_APP_PRIVATE_KEY: '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEAx9uYc0ffeeBADBEEF1234567890abcdefXYZ\n-----END RSA PRIVATE KEY-----',
  DATABASE_MIGRATE_URL: 'postgres://migrator:S3cr3t-Pa55word!@db:5432/mergecrew',
  DATABASE_URL: 'postgres://mergecrew:mergecrew@localhost:5432/mergecrew',
  NODE_ENV: 'production',
  PATH: '/usr/bin',
} as unknown as NodeJS.ProcessEnv;

describe('scanText patterns', () => {
  const hits: Array<[string, string]> = [
    ['github_token', 'token ghs_16C7e42F292c6912E7710c838347Ae178B4a in body'],
    ['github_token', 'ghp_abcdefghijklmnopqrstuvwxyz0123456789'],
    ['github_pat', 'github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz'],
    ['aws_access_key_id', 'AKIAIOSFODNN7EXAMPLE'],
    ['aws_access_key_id', 'ASIAY34FZKBOKMUTVV7A'],
    ['private_key', '-----BEGIN OPENSSH PRIVATE KEY-----'],
    ['private_key', '-----BEGIN PRIVATE KEY-----'],
    ['anthropic_api_key', 'sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAA'],
    ['api_secret_key', 'sk-proj-abcdefghijklmnopqrstuvwx'],
    ['mergecrew_api_key', 'mc_live_0123456789abcdefghij'],
  ];
  for (const [kind, text] of hits) {
    it(`flags ${kind}: ${text.slice(0, 18)}…`, () => {
      expect(scanText(text, 'x', { env: {} }).map((f) => f.kind)).toContain(kind);
    });
  }

  it('does not flag ordinary engineering text', () => {
    for (const t of [
      'fix(auth): handle expired sessions in mergecrew/run-42',
      'Uses scikit-learn and sk-learn-style pipelines',
      'BEGIN PUBLIC KEY block parsing',
      'task-abcdefghijklmnopqrstuvwxyz0123',
      'See ghs_ prefix docs',
    ]) {
      expect(scanText(t, 'x', { env }), t).toEqual([]);
    }
  });
});

describe('known secret values from the runner env', () => {
  it('matches exact secret env values, PEM body lines and URL passwords', () => {
    expect(scanText(`leak ${env.KMS_MASTER_KEY} here`, 'x', { env }).map((f) => f.kind)).toContain('known_secret_value');
    expect(scanText('MIIEowIBAAKCAQEAx9uYc0ffeeBADBEEF1234567890abcdefXYZ', 'x', { env })).not.toEqual([]);
    expect(scanText('password is S3cr3t-Pa55word!', 'x', { env })).not.toEqual([]);
  });

  it('ignores low-entropy dev values (no blocking every "mergecrew" string)', () => {
    expect(knownSecretValues(env)).not.toContain('mergecrew');
    expect(scanText('mergecrew/run-1 by mergecrew', 'x', { env })).toEqual([]);
  });

  it('ignores non-secret env names', () => {
    expect(knownSecretValues({ HOSTNAME: 'very-long-hostname-1234567890' } as any)).toEqual([]);
  });

  it('runtime-registered values (minted tokens, tenant secrets) are matched', () => {
    registerKnownSecret('tenant-secret-Value-9876543210');
    expect(scanText('x tenant-secret-Value-9876543210 y', 'x', { env: {} })).not.toEqual([]);
  });
});

describe('scanValue / assertNoSecrets', () => {
  it('walks nested inputs and reports locations without echoing the secret', () => {
    const f = scanValue({ title: 'ok', body: { parts: ['fine', `k=${env.KMS_MASTER_KEY}`] } }, 'input', { env });
    expect(f).toEqual([{ kind: 'known_secret_value', location: 'input.body.parts[1]' }]);
    try {
      assertNoSecrets(`x ${env.KMS_MASTER_KEY}`, 'PR body', { env });
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(OutboundSecretError);
      expect(String((e as Error).message)).not.toContain(env.KMS_MASTER_KEY as string);
    }
  });
});

describe('SkillExecutor outbound scan', () => {
  const sent: unknown[] = [];
  const outbound: AnySkill = {
    name: 'repo.git.comment_pr',
    description: '',
    inputSchema: {},
    sideEffectClass: 'write_external',
    capabilities: ['net.outbound'],
    async execute(input) {
      sent.push(input);
      return { output: 'ok', brief: 'ok' };
    },
  };
  const ctx: SkillExecutionContext = {
    organizationId: 'o',
    projectId: 'p',
    abortSignal: new AbortController().signal,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    adapters: {},
  };

  it('blocks a PR comment / review / http body carrying a supervisor secret', async () => {
    const prev = process.env.KMS_MASTER_KEY;
    process.env.KMS_MASTER_KEY = 'Zm9vYmFyLXNlY3JldC1rZXktMTIzNDU2Nzg5';
    try {
      const ex = new SkillExecutor();
      ex.register(outbound);
      await expect(
        ex.execute('repo.git.comment_pr', { number: 1, body: `here: ${process.env.KMS_MASTER_KEY}` }, ctx),
      ).rejects.toBeInstanceOf(OutboundSecretError);
      await expect(
        ex.execute('repo.git.comment_pr', { number: 1, body: 'ghs_16C7e42F292c6912E7710c838347Ae178B4a' }, ctx),
      ).rejects.toBeInstanceOf(OutboundSecretError);
      expect(sent).toHaveLength(0);
      await ex.execute('repo.git.comment_pr', { number: 1, body: 'LGTM' }, ctx);
      expect(sent).toHaveLength(1);
    } finally {
      if (prev === undefined) delete process.env.KMS_MASTER_KEY;
      else process.env.KMS_MASTER_KEY = prev;
    }
  });
});
