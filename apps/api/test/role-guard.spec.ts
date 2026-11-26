import { ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { MFA_FRESHNESS_WINDOW_MS, RoleGuard, mfaFreshnessViolation } from '../src/common/role.guard';

const now = Date.now();
const enrolled = (mfaAgoMs?: number) => ({
  userId: 'u1',
  mfaEnrolled: true,
  ...(mfaAgoMs !== undefined ? { mfaChallengedAt: new Date(now - mfaAgoMs) } : {}),
});

describe('mfaFreshnessViolation', () => {
  it('requires a fresh challenge for enrolled admin/owner writes', () => {
    expect(mfaFreshnessViolation({ required: 'admin', method: 'POST', user: enrolled(), now })).toBe(true);
    expect(
      mfaFreshnessViolation({ required: 'owner', method: 'DELETE', user: enrolled(MFA_FRESHNESS_WINDOW_MS + 1000), now }),
    ).toBe(true);
    expect(mfaFreshnessViolation({ required: 'admin', method: 'PATCH', user: enrolled(60_000), now })).toBe(false);
  });

  it('does not gate reads, lower roles, API keys, or non-enrolled users', () => {
    expect(mfaFreshnessViolation({ required: 'admin', method: 'GET', user: enrolled(), now })).toBe(false);
    expect(mfaFreshnessViolation({ required: 'operator', method: 'POST', user: enrolled(), now })).toBe(false);
    expect(
      mfaFreshnessViolation({ required: 'admin', method: 'POST', user: { ...enrolled(), apiKeyId: 'k1' }, now }),
    ).toBe(false);
    expect(
      mfaFreshnessViolation({ required: 'admin', method: 'POST', user: { userId: 'u1', mfaEnrolled: false }, now }),
    ).toBe(false);
  });
});

describe('RoleGuard', () => {
  function run(user: any, method: string, required = 'admin') {
    const reflector = { getAllAndOverride: () => required } as unknown as Reflector;
    const tenant = {
      current: () => ({ organizationId: 'o', organizationSlug: 's', userId: 'u1', role: 'owner' }),
      user: () => user,
    } as any;
    const ctx = {
      getHandler: () => null,
      getClass: () => null,
      switchToHttp: () => ({ getRequest: () => ({ method }) }),
    } as any;
    return new RoleGuard(reflector, tenant).canActivate(ctx);
  }

  it('throws MFA_REQUIRED for a stale enrolled admin write', () => {
    try {
      run(enrolled(MFA_FRESHNESS_WINDOW_MS * 2), 'POST');
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(ForbiddenException);
      expect((e as ForbiddenException).getResponse()).toMatchObject({ code: 'MFA_REQUIRED' });
    }
  });

  it('allows a fresh challenge and reads', () => {
    expect(run(enrolled(1000), 'POST')).toBe(true);
    expect(run(enrolled(), 'GET')).toBe(true);
  });
});
