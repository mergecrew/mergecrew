import { JwtService } from '@nestjs/jwt';
import { checkSessionToken, isMfaChallengeRoute } from '../src/common/session-token';
import { AuthService } from '../src/modules/auth/auth.service';

const jwt = new JwtService({ secret: 'test-secret', signOptions: { expiresIn: '14d' } });
const auth = new AuthService({} as any, jwt);

const user = (over: Partial<{ tokenVersion: number; mfaEnrolledAt: Date | null }> = {}) => ({
  tokenVersion: 0,
  mfaEnrolledAt: null,
  ...over,
});

describe('checkSessionToken', () => {
  it('accepts a current session token', async () => {
    const token = auth.signSessionJwt('u1', { tokenVersion: 3 });
    const r = await checkSessionToken({ jwt, token, loadUser: async () => user({ tokenVersion: 3 }) });
    expect(r).toMatchObject({ ok: true, userId: 'u1', mfaEnrolled: false, mfaPending: false });
  });

  it('rejects a token revoked by sign-out (token version bumped)', async () => {
    const token = auth.signSessionJwt('u1', { tokenVersion: 0 });
    const r = await checkSessionToken({ jwt, token, loadUser: async () => user({ tokenVersion: 1 }) });
    expect(r).toEqual(expect.objectContaining({ ok: false, code: 'SESSION_REVOKED' }));
  });

  it('treats legacy tokens without `tv` as version 0', async () => {
    const token = jwt.sign({ sub: 'u1' });
    expect((await checkSessionToken({ jwt, token, loadUser: async () => user() })).ok).toBe(true);
    expect(
      (await checkSessionToken({ jwt, token, loadUser: async () => user({ tokenVersion: 1 }) })).ok,
    ).toBe(false);
  });

  it('rejects a full session without mfa_at for an MFA-enrolled user', async () => {
    const token = auth.signSessionJwt('u1', { tokenVersion: 0 });
    const r = await checkSessionToken({
      jwt,
      token,
      loadUser: async () => user({ mfaEnrolledAt: new Date() }),
    });
    expect(r).toEqual(expect.objectContaining({ ok: false, code: 'MFA_CHALLENGE_REQUIRED' }));
  });

  it('accepts an MFA-enrolled session that passed the challenge', async () => {
    const at = new Date(Math.floor(Date.now() / 1000) * 1000);
    const token = auth.signSessionJwt('u1', { tokenVersion: 0, mfaAt: at });
    const r = await checkSessionToken({
      jwt,
      token,
      loadUser: async () => user({ mfaEnrolledAt: new Date() }),
    });
    expect(r).toMatchObject({ ok: true, mfaEnrolled: true });
    if (r.ok) expect(r.mfaChallengedAt?.getTime()).toBe(at.getTime());
  });

  it('only accepts a pre-MFA token where explicitly allowed', async () => {
    const token = auth.signMfaPendingJwt('u1', { tokenVersion: 0 });
    const loadUser = async () => user({ mfaEnrolledAt: new Date() });
    expect(await checkSessionToken({ jwt, token, loadUser })).toEqual(
      expect.objectContaining({ ok: false, code: 'MFA_CHALLENGE_REQUIRED' }),
    );
    expect(await checkSessionToken({ jwt, token, loadUser, allowMfaPending: true })).toMatchObject({
      ok: true,
      mfaPending: true,
    });
  });

  it('pre-MFA tokens are short-lived', () => {
    const token = auth.signMfaPendingJwt('u1', { tokenVersion: 0 });
    const { exp, iat } = jwt.decode(token) as { exp: number; iat: number };
    expect(exp - iat).toBeLessThanOrEqual(10 * 60);
  });

  it('rejects unknown token types, bad signatures, and deleted users', async () => {
    const loadUser = async () => user();
    expect((await checkSessionToken({ jwt, token: jwt.sign({ sub: 'u1', typ: 'other' }), loadUser })).ok).toBe(false);
    const foreign = new JwtService({ secret: 'other' }).sign({ sub: 'u1' });
    expect((await checkSessionToken({ jwt, token: foreign, loadUser })).ok).toBe(false);
    expect(await checkSessionToken({ jwt, token: jwt.sign({ sub: 'u1' }), loadUser: async () => null })).toEqual(
      expect.objectContaining({ ok: false, code: 'STALE_SESSION' }),
    );
    expect((await checkSessionToken({ jwt, token: undefined, loadUser })).ok).toBe(false);
  });

  it('identifies the MFA challenge route', () => {
    expect(isMfaChallengeRoute('POST', '/v1/me/mfa/challenge')).toBe(true);
    expect(isMfaChallengeRoute('GET', '/v1/me/mfa/challenge')).toBe(false);
    expect(isMfaChallengeRoute('POST', '/v1/me/mfa/setup')).toBe(false);
    expect(isMfaChallengeRoute('POST', '/v1/orgs/x/projects')).toBe(false);
  });
});

describe('AuthService.issueLogin', () => {
  it('issues a full session for users without MFA', () => {
    const r = auth.issueLogin({ id: 'u1', email: 'a@b.c', name: null, tokenVersion: 2, mfaEnrolledAt: null });
    expect('token' in r).toBe(true);
    if ('token' in r) expect(jwt.decode(r.token)).toMatchObject({ sub: 'u1', tv: 2 });
  });

  it('issues only a pre-MFA token for enrolled users', () => {
    const r = auth.issueLogin({ id: 'u1', email: 'a@b.c', name: null, tokenVersion: 0, mfaEnrolledAt: new Date() });
    expect(r).toMatchObject({ mfaRequired: true });
    expect('token' in r).toBe(false);
    if ('mfaToken' in r) expect(jwt.decode(r.mfaToken)).toMatchObject({ typ: 'mfa_pending' });
  });
});
