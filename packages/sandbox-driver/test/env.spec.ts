import { describe, expect, it } from 'vitest';
import {
  BASE_ALLOWED_ENV,
  SENSITIVE_ENV_PREFIXES,
  buildScrubbedEnv,
  classifySensitiveKey,
} from '../src/env.js';

describe('buildScrubbedEnv', () => {
  it('passes through only the base allowed keys', () => {
    const src = {
      PATH: '/usr/bin',
      HOME: '/home/x',
      KMS_MASTER_KEY: 'hunter2',
      GITHUB_APP_PRIVATE_KEY: 'PEM',
      AWS_ACCESS_KEY_ID: 'AKIA…',
      VERCEL_TOKEN: 'vt…',
      ANTHROPIC_API_KEY: 'sk-ant…',
      DATABASE_URL: 'postgres://…',
      CI: 'true',
      FORCE_COLOR: '0',
    };
    const out = buildScrubbedEnv(src);
    expect(out).toEqual({
      PATH: '/usr/bin',
      HOME: '/home/x',
      CI: 'true',
      FORCE_COLOR: '0',
    });
  });

  it('drops keys not in the allowlist (even unrecognized ones)', () => {
    const out = buildScrubbedEnv({ NODE_VERSION: '20', OPENAI_API_KEY: 'leak' });
    expect(out).toEqual({});
  });

  it('skips allowed keys that are undefined in the source', () => {
    const out = buildScrubbedEnv({ PATH: undefined as any, HOME: '/h' });
    expect(out).toEqual({ HOME: '/h' });
  });

  it('does not invent default values', () => {
    const out = buildScrubbedEnv({});
    expect(out).toEqual({});
  });
});

describe('classifySensitiveKey', () => {
  it('returns the prefix for known sensitive patterns', () => {
    expect(classifySensitiveKey('KMS_MASTER_KEY')).toBe('KMS_');
    expect(classifySensitiveKey('GITHUB_APP_PRIVATE_KEY')).toBe('GITHUB_APP_');
    expect(classifySensitiveKey('AWS_SECRET_ACCESS_KEY')).toBe('AWS_');
    expect(classifySensitiveKey('OPENAI_API_KEY')).toBe('OPENAI_');
    expect(classifySensitiveKey('VERCEL_TOKEN')).toBe('VERCEL_');
  });

  it('is case-insensitive', () => {
    expect(classifySensitiveKey('aws_session_token')).toBe('AWS_');
  });

  it('returns undefined for benign keys', () => {
    expect(classifySensitiveKey('CI')).toBeUndefined();
    expect(classifySensitiveKey('PATH')).toBeUndefined();
    expect(classifySensitiveKey('NODE_ENV')).toBeUndefined();
  });
});

describe('BASE_ALLOWED_ENV / SENSITIVE_ENV_PREFIXES are disjoint', () => {
  it('no allowed key matches a sensitive prefix', () => {
    for (const allowed of BASE_ALLOWED_ENV) {
      expect(classifySensitiveKey(allowed)).toBeUndefined();
    }
  });

  it('SENSITIVE_ENV_PREFIXES list looks sane', () => {
    expect(SENSITIVE_ENV_PREFIXES).toContain('KMS_');
    expect(SENSITIVE_ENV_PREFIXES).toContain('AWS_');
    expect(SENSITIVE_ENV_PREFIXES).toContain('GITHUB_APP_');
  });
});
