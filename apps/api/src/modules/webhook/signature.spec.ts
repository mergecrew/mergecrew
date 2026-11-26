import crypto from 'node:crypto';
import { ForbiddenException } from '@nestjs/common';
import {
  requireWebhookSecret,
  safeEqual,
  verifyGitHubSignature,
  verifyLinearWebhook,
  verifySentrySignature,
  verifySlackSignature,
} from './signature';

const SECRET = 'whsec-test-123';
const hmac = (key: string, data: Buffer | string) =>
  crypto.createHmac('sha256', key).update(data).digest('hex');

describe('requireWebhookSecret', () => {
  const ENV = 'MC_TEST_WEBHOOK_SECRET';
  afterEach(() => {
    delete process.env[ENV];
  });

  it('throws 403 when unset', () => {
    expect(() => requireWebhookSecret(ENV, 'test')).toThrow(ForbiddenException);
  });

  it('throws 403 when empty or blank', () => {
    process.env[ENV] = '';
    expect(() => requireWebhookSecret(ENV, 'test')).toThrow(ForbiddenException);
    process.env[ENV] = '   ';
    expect(() => requireWebhookSecret(ENV, 'test')).toThrow(ForbiddenException);
  });

  it('returns the secret when set', () => {
    process.env[ENV] = SECRET;
    expect(requireWebhookSecret(ENV, 'test')).toBe(SECRET);
  });
});

describe('safeEqual', () => {
  it('compares strings', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
  });
});

describe('verifyGitHubSignature', () => {
  const body = Buffer.from(JSON.stringify({ zen: 'Keep it logically awesome.', hook_id: 1 }));

  it('accepts a valid signature', () => {
    expect(verifyGitHubSignature({ 'x-hub-signature-256': `sha256=${hmac(SECRET, body)}` }, body, SECRET)).toBe(true);
  });

  it('rejects an invalid signature, a tampered body and a missing header', () => {
    expect(verifyGitHubSignature({ 'x-hub-signature-256': `sha256=${'0'.repeat(64)}` }, body, SECRET)).toBe(false);
    expect(
      verifyGitHubSignature(
        { 'x-hub-signature-256': `sha256=${hmac(SECRET, body)}` },
        Buffer.from('{"zen":"tampered"}'),
        SECRET,
      ),
    ).toBe(false);
    expect(verifyGitHubSignature({}, body, SECRET)).toBe(false);
    expect(verifyGitHubSignature({ 'x-hub-signature-256': hmac(SECRET, body) }, body, SECRET)).toBe(false);
  });

  it('fails closed with an empty secret even if the signature uses the empty key', () => {
    expect(verifyGitHubSignature({ 'x-hub-signature-256': `sha256=${hmac('', body)}` }, body, '')).toBe(false);
  });
});

describe('verifySentrySignature', () => {
  const body = Buffer.from('{"action":"created"}');

  it('accepts valid, rejects invalid / empty secret', () => {
    expect(verifySentrySignature({ 'sentry-hook-signature': hmac(SECRET, body) }, body, SECRET)).toBe(true);
    expect(verifySentrySignature({ 'sentry-hook-signature': hmac('other', body) }, body, SECRET)).toBe(false);
    expect(verifySentrySignature({ 'sentry-hook-signature': hmac('', body) }, body, '')).toBe(false);
    expect(verifySentrySignature({}, body, SECRET)).toBe(false);
  });
});

describe('verifyLinearWebhook', () => {
  const now = 1_800_000_000_000;
  const mk = (ts: number) => Buffer.from(JSON.stringify({ action: 'create', type: 'Issue', webhookTimestamp: ts }));

  it('accepts a valid, fresh signature and returns the payload', () => {
    const body = mk(now - 5_000);
    const parsed = verifyLinearWebhook({ 'linear-signature': hmac(SECRET, body) }, body, SECRET, now);
    expect(parsed).toMatchObject({ action: 'create', type: 'Issue' });
  });

  it('rejects unsigned, wrongly signed and tampered requests', () => {
    const body = mk(now);
    expect(verifyLinearWebhook({}, body, SECRET, now)).toBeNull();
    expect(verifyLinearWebhook({ 'linear-signature': hmac('nope', body) }, body, SECRET, now)).toBeNull();
    expect(verifyLinearWebhook({ 'linear-signature': hmac(SECRET, body) }, mk(now + 1), SECRET, now)).toBeNull();
  });

  it('rejects stale or missing webhookTimestamp (replay)', () => {
    const stale = mk(now - 61_000);
    expect(verifyLinearWebhook({ 'linear-signature': hmac(SECRET, stale) }, stale, SECRET, now)).toBeNull();
    const noTs = Buffer.from('{"action":"create"}');
    expect(verifyLinearWebhook({ 'linear-signature': hmac(SECRET, noTs) }, noTs, SECRET, now)).toBeNull();
  });

  it('fails closed with an empty secret', () => {
    const body = mk(now);
    expect(verifyLinearWebhook({ 'linear-signature': hmac('', body) }, body, '', now)).toBeNull();
  });
});

describe('verifySlackSignature', () => {
  const now = 1_800_000_000_000;
  const ts = String(Math.floor(now / 1000));
  const body = Buffer.from('payload=%7B%7D');
  const sig = (key: string, t = ts) => `v0=${hmac(key, `v0:${t}:${body.toString('utf8')}`)}`;

  it('accepts valid, rejects invalid / stale / empty secret', () => {
    expect(verifySlackSignature({ 'x-slack-request-timestamp': ts, 'x-slack-signature': sig(SECRET) }, body, SECRET, now)).toBe(true);
    expect(verifySlackSignature({ 'x-slack-request-timestamp': ts, 'x-slack-signature': sig('x') }, body, SECRET, now)).toBe(false);
    const old = String(Math.floor(now / 1000) - 301);
    expect(
      verifySlackSignature({ 'x-slack-request-timestamp': old, 'x-slack-signature': sig(SECRET, old) }, body, SECRET, now),
    ).toBe(false);
    expect(verifySlackSignature({ 'x-slack-request-timestamp': ts, 'x-slack-signature': sig('') }, body, '', now)).toBe(false);
  });
});
