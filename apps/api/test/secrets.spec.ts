import { randomBytes } from 'node:crypto';
import {
  DEV_KMS_MASTER_KEY,
  assertProductionSecrets,
  bffTrustToken,
  findSecretProblems,
  isInsecureKmsKey,
  jwtSecret,
  kmsMasterKey,
  safeEqual,
} from '../src/common/secrets';
import { CryptoService } from '../src/common/crypto.service';

const goodKms = () => `base64:${randomBytes(32).toString('base64')}`;
const good = () => ({
  NODE_ENV: 'production',
  JWT_SECRET: randomBytes(32).toString('hex'),
  BFF_TRUST_TOKEN: randomBytes(32).toString('hex'),
  KMS_MASTER_KEY: goodKms(),
});

describe('production secret checks', () => {
  it('accepts strong secrets in production', () => {
    expect(() => assertProductionSecrets(good())).not.toThrow();
    expect(findSecretProblems(good())).toEqual([]);
  });

  it.each([
    ['JWT_SECRET', undefined],
    ['JWT_SECRET', 'dev-secret'],
    ['JWT_SECRET', 'change-me-in-prod'],
    ['BFF_TRUST_TOKEN', undefined],
    ['BFF_TRUST_TOKEN', 'dev-trust-token'],
    ['KMS_MASTER_KEY', undefined],
    ['KMS_MASTER_KEY', DEV_KMS_MASTER_KEY],
    ['KMS_MASTER_KEY', 'base64:dG9vLXNob3J0'],
  ])('refuses to boot when %s is %p', (name, value) => {
    const env: Record<string, string | undefined> = { ...good(), [name]: value };
    expect(() => assertProductionSecrets(env)).toThrow(/refusing to start/);
  });

  it('does nothing outside production', () => {
    expect(() => assertProductionSecrets({ NODE_ENV: 'development' })).not.toThrow();
    expect(jwtSecret({})).toBe('dev-secret');
    expect(bffTrustToken({})).toBe('dev-trust-token');
  });

  it('only warns with the explicit insecure-defaults escape hatch', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    expect(() =>
      assertProductionSecrets({ NODE_ENV: 'production', MERGECREW_ALLOW_INSECURE_DEFAULTS: 'true' }),
    ).not.toThrow();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('accessors refuse missing secrets in production', () => {
    expect(() => jwtSecret({ NODE_ENV: 'production' })).toThrow(/JWT_SECRET/);
    expect(() => bffTrustToken({ NODE_ENV: 'production' })).toThrow(/BFF_TRUST_TOKEN/);
    expect(() => kmsMasterKey({ NODE_ENV: 'production', KMS_MASTER_KEY: DEV_KMS_MASTER_KEY })).toThrow(
      /KMS_MASTER_KEY/,
    );
  });

  it('detects the all-zero KMS key', () => {
    expect(isInsecureKmsKey(DEV_KMS_MASTER_KEY)).toBe(true);
    expect(isInsecureKmsKey(goodKms())).toBe(false);
  });

  it('CryptoService refuses the zero key in production', () => {
    const prev = { ...process.env };
    try {
      process.env.NODE_ENV = 'production';
      process.env.KMS_MASTER_KEY = DEV_KMS_MASTER_KEY;
      delete process.env.MERGECREW_ALLOW_INSECURE_DEFAULTS;
      expect(() => new CryptoService()).toThrow(/KMS_MASTER_KEY/);
      process.env.KMS_MASTER_KEY = goodKms();
      const c = new CryptoService();
      expect(c.decrypt(c.encrypt('hello'))).toBe('hello');
    } finally {
      process.env = prev;
    }
  });
});

describe('safeEqual', () => {
  it('compares in constant time and rejects mismatches', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abd', 'abc')).toBe(false);
    expect(safeEqual('ab', 'abc')).toBe(false);
    expect(safeEqual(undefined, 'abc')).toBe(false);
    expect(safeEqual('', '')).toBe(false);
  });
});
