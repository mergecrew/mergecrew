import { HttpException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { authenticator } from 'otplib';
import { CryptoService } from '../src/common/crypto.service';
import { AuthService } from '../src/modules/auth/auth.service';
import { MFA_MAX_FAILED_ATTEMPTS, MfaService } from '../src/modules/mfa/mfa.service';
import { createFakeDb, fakeTenant } from './helpers/fake-prisma';

const T0 = new Date('2026-11-26T12:00:00Z').getTime();

function setup() {
  const { db, prisma } = createFakeDb();
  const jwt = new JwtService({ secret: 'test-secret' });
  const auth = new AuthService(prisma, jwt);
  const crypto = new CryptoService();
  const user = { id: 'user-1', email: 'u@example.com' };
  db.user.rows.push({ ...(db.user as any).defaults?.(), ...baseUser(user) });
  const svc = new MfaService(prisma, fakeTenant({ userId: user.id }), crypto, auth);
  return { db, svc, jwt, crypto, user };
}

function baseUser(u: { id: string; email: string }) {
  return {
    ...u,
    name: null,
    mfaSecretCiphertext: null,
    mfaPendingCiphertext: null,
    mfaEnrolledAt: null,
    mfaLastUsedStep: null,
    mfaFailedAttempts: 0,
    mfaLockedUntil: null,
    tokenVersion: 4,
  };
}

async function enrol(svc: MfaService) {
  const { secret } = await svc.setup();
  const { recoveryCodes, token } = await svc.verify({ code: authenticator.generate(secret) });
  return { secret, recoveryCodes, token };
}

/** Move to the next 30s TOTP step so a fresh code is available. */
function nextStep() {
  jest.setSystemTime(Date.now() + 30_000);
}

describe('MfaService', () => {
  beforeEach(() => {
    jest.useFakeTimers({ now: T0 });
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('enrols and returns a session token carrying mfa_at and the token version', async () => {
    const { svc, jwt, db } = setup();
    const { recoveryCodes, token } = await enrol(svc);
    expect(recoveryCodes).toHaveLength(10);
    expect(jwt.decode(token)).toMatchObject({ sub: 'user-1', tv: 4, mfa_at: Math.floor(T0 / 1000) });
    expect(db.user.rows[0].mfaEnrolledAt).toBeInstanceOf(Date);
  });

  it('requires the current TOTP to re-enrol an enrolled account (force or not)', async () => {
    const { svc, db } = setup();
    const { secret } = await enrol(svc);
    const original = db.user.rows[0].mfaSecretCiphertext;
    nextStep();

    await expect(svc.setup({ force: true })).rejects.toThrow(/already enrolled/);
    await expect(svc.setup({})).rejects.toThrow(/already enrolled/);
    await expect(svc.setup({ force: true, code: '000000' })).rejects.toThrow(/invalid/);
    expect(db.user.rows[0].mfaPendingCiphertext).toBeNull();

    const r = await svc.setup({ force: true, code: authenticator.generate(secret) });
    expect(r.secret).not.toBe(secret);
    // The confirmed secret is untouched until the new one is verified.
    expect(db.user.rows[0].mfaSecretCiphertext).toBe(original);
  });

  it('rejects a TOTP code that was already used (replay)', async () => {
    const { svc } = setup();
    const { secret } = await enrol(svc);
    nextStep();
    const code = authenticator.generate(secret);
    await expect(svc.challenge({ code })).resolves.toMatchObject({ kind: 'totp' });
    await expect(svc.challenge({ code })).rejects.toThrow(/invalid/);
    nextStep();
    await expect(svc.challenge({ code: authenticator.generate(secret) })).resolves.toMatchObject({
      kind: 'totp',
    });
  });

  it('the enrolment code itself cannot be replayed at the challenge', async () => {
    const { svc } = setup();
    const { secret } = await svc.setup();
    const code = authenticator.generate(secret);
    await svc.verify({ code });
    await expect(svc.challenge({ code })).rejects.toThrow(/invalid/);
  });

  it('accepts each recovery code once', async () => {
    const { svc } = setup();
    const { recoveryCodes } = await enrol(svc);
    await expect(svc.challenge({ code: recoveryCodes[0]! })).resolves.toMatchObject({
      kind: 'recovery',
      recoveryCodesRemaining: 9,
    });
    await expect(svc.challenge({ code: recoveryCodes[0]! })).rejects.toThrow(/invalid/);
  });

  it('locks MFA checks after repeated failures and records the lockout', async () => {
    const { svc, db } = setup();
    const { secret } = await enrol(svc);
    for (let i = 0; i < MFA_MAX_FAILED_ATTEMPTS; i++) {
      await expect(svc.challenge({ code: '000000' })).rejects.toThrow(/invalid/);
    }
    expect(db.user.rows[0].mfaLockedUntil).toBeInstanceOf(Date);
    nextStep();
    // Even a correct code is refused while locked, with a 429.
    const err = await svc.challenge({ code: authenticator.generate(secret) }).catch((e) => e);
    expect(err).toBeInstanceOf(HttpException);
    expect((err as HttpException).getStatus()).toBe(429);
    // Disable / regenerate are locked too.
    await expect(svc.disable({ code: authenticator.generate(secret) })).rejects.toBeInstanceOf(HttpException);

    jest.setSystemTime(Date.now() + 16 * 60_000);
    await expect(svc.challenge({ code: authenticator.generate(secret) })).resolves.toMatchObject({
      kind: 'totp',
    });
    expect(db.user.rows[0].mfaFailedAttempts).toBe(0);
  });

  it('challenge returns a token with a fresh mfa_at for the current token version', async () => {
    const { svc, jwt, db } = setup();
    const { secret } = await enrol(svc);
    db.user.rows[0].tokenVersion = 9;
    nextStep();
    const r = await svc.challenge({ code: authenticator.generate(secret) });
    expect(jwt.decode(r.token)).toMatchObject({ sub: 'user-1', tv: 9 });
    expect(r.user).toEqual({ id: 'user-1', email: 'u@example.com', name: null });
  });
});
