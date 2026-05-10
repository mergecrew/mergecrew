import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { verifyWebhook, WebhookVerificationError } from '../src/webhook.js';

const SECRET = 'whsec_test';
const fakeNow = () => 1_700_000_000_000;
const t = Math.floor(fakeNow() / 1000);
const body = JSON.stringify({ type: 'webhook.test', data: { hi: 'world' } });
const sigHex = createHmac('sha256', SECRET).update(`${t}.${body}`).digest('hex');

describe('verifyWebhook', () => {
  it('accepts a correct signature inside the tolerance window', () => {
    expect(() =>
      verifyWebhook(
        body,
        { 'x-mergecrew-signature': `t=${t},v1=${sigHex}` },
        SECRET,
        { now: fakeNow },
      ),
    ).not.toThrow();
  });

  it('is case-insensitive on the header name', () => {
    expect(() =>
      verifyWebhook(
        body,
        { 'X-Mergecrew-Signature': `t=${t},v1=${sigHex}` },
        SECRET,
        { now: fakeNow },
      ),
    ).not.toThrow();
  });

  it('rejects a missing header', () => {
    expect(() => verifyWebhook(body, {}, SECRET, { now: fakeNow })).toThrow(
      WebhookVerificationError,
    );
  });

  it('rejects a malformed header', () => {
    expect(() =>
      verifyWebhook(body, { 'x-mergecrew-signature': 'not-a-real-sig' }, SECRET, { now: fakeNow }),
    ).toThrow(/malformed/);
  });

  it('rejects a signature outside the tolerance window', () => {
    const oldT = t - 10_000;
    const oldSig = createHmac('sha256', SECRET).update(`${oldT}.${body}`).digest('hex');
    expect(() =>
      verifyWebhook(
        body,
        { 'x-mergecrew-signature': `t=${oldT},v1=${oldSig}` },
        SECRET,
        { now: fakeNow },
      ),
    ).toThrow(/tolerance/);
  });

  it('rejects a tampered body', () => {
    expect(() =>
      verifyWebhook(
        body + 'tampered',
        { 'x-mergecrew-signature': `t=${t},v1=${sigHex}` },
        SECRET,
        { now: fakeNow },
      ),
    ).toThrow(/mismatch/);
  });

  it('rejects a wrong secret', () => {
    expect(() =>
      verifyWebhook(
        body,
        { 'x-mergecrew-signature': `t=${t},v1=${sigHex}` },
        'wrong-secret',
        { now: fakeNow },
      ),
    ).toThrow(/mismatch/);
  });
});
