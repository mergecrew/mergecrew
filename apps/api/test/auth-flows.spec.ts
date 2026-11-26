import { UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { AuthController } from '../src/modules/auth/auth.controller';
import { AuthService } from '../src/modules/auth/auth.service';
import { MagicLinkService } from '../src/modules/magic-link/magic-link.service';
import { createFakeDb } from './helpers/fake-prisma';

const jwt = new JwtService({ secret: 'test-secret' });

function users(db: ReturnType<typeof createFakeDb>['db'], over: Record<string, unknown> = {}) {
  db.user.rows.push({
    id: 'user-1',
    email: 'u@example.com',
    name: null,
    avatarUrl: null,
    mfaEnrolledAt: null,
    tokenVersion: 0,
    ...over,
  });
}

describe('AuthController', () => {
  const prevToken = process.env.BFF_TRUST_TOKEN;
  beforeAll(() => {
    process.env.BFF_TRUST_TOKEN = 'trust-abc';
  });
  afterAll(() => {
    process.env.BFF_TRUST_TOKEN = prevToken;
  });

  function make(over: Record<string, unknown> = {}) {
    const { db, prisma } = createFakeDb();
    users(db, over);
    const auth = new AuthService(prisma, jwt);
    return { db, auth, ctrl: new AuthController(auth, jwt, prisma) };
  }

  it('exchange rejects a wrong or missing trust token', async () => {
    const { ctrl } = make();
    await expect(ctrl.exchange({ email: 'u@example.com', trustToken: 'trust-abd' })).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    await expect(ctrl.exchange({ email: 'u@example.com' })).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('exchange issues a session, or only a pre-MFA token for enrolled users', async () => {
    const plain = await make().ctrl.exchange({ email: 'u@example.com', trustToken: 'trust-abc' });
    expect(plain).toHaveProperty('token');
    const gated = await make({ mfaEnrolledAt: new Date() }).ctrl.exchange({
      email: 'u@example.com',
      trustToken: 'trust-abc',
    });
    expect(gated).toMatchObject({ mfaRequired: true });
    expect(gated).not.toHaveProperty('token');
  });

  it('logout revokes the session server-side', async () => {
    const { ctrl, auth, db } = make();
    const token = auth.signSessionJwt('user-1', { tokenVersion: 0 });
    await expect(ctrl.whoami(`Bearer ${token}`)).resolves.toMatchObject({ userId: 'user-1' });
    await ctrl.logout(`Bearer ${token}`);
    expect(db.user.rows[0].tokenVersion).toBe(1);
    await expect(ctrl.whoami(`Bearer ${token}`)).rejects.toBeInstanceOf(UnauthorizedException);
    // Replaying the revoked token cannot bump the version again.
    await ctrl.logout(`Bearer ${token}`);
    expect(db.user.rows[0].tokenVersion).toBe(1);
  });
});

describe('MagicLinkService', () => {
  function make(over: Record<string, unknown> = {}) {
    const { db, prisma } = createFakeDb();
    users(db, over);
    const svc = new MagicLinkService(prisma, new AuthService(prisma, jwt));
    const sent: string[] = [];
    (svc as any).email = { send: async (_to: string[], _s: string, html: string) => void sent.push(html) };
    return { db, svc, sent };
  }

  const tokenFrom = (html: string) => decodeURIComponent(/token=([^&"]+)/.exec(html)![1]!);

  it('sends at most one link per address per cooldown window', async () => {
    const { svc, sent } = make();
    await svc.request({ email: 'u@example.com' });
    await svc.request({ email: 'U@example.com' });
    expect(sent).toHaveLength(1);
  });

  it('verify returns a session for plain users and a pre-MFA token for enrolled ones', async () => {
    const plain = make();
    await plain.svc.request({ email: 'u@example.com' });
    const r1 = await plain.svc.verify({ email: 'u@example.com', token: tokenFrom(plain.sent[0]!) });
    expect(r1).toHaveProperty('token');

    const gated = make({ mfaEnrolledAt: new Date() });
    await gated.svc.request({ email: 'u@example.com' });
    const r2 = await gated.svc.verify({ email: 'u@example.com', token: tokenFrom(gated.sent[0]!) });
    expect(r2).toMatchObject({ mfaRequired: true });
    expect(r2).not.toHaveProperty('token');
    if ('mfaToken' in r2) expect(jwt.decode(r2.mfaToken)).toMatchObject({ typ: 'mfa_pending' });
  });
});
