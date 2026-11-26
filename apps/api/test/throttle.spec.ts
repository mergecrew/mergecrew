import { Test } from '@nestjs/testing';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerModule } from '@nestjs/throttler';
import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { AddressInfo } from 'node:net';
import { AppThrottlerGuard, isThrottleExemptPath } from '../src/common/throttle';
import { MfaController } from '../src/modules/mfa/mfa.controller';
import { MfaService } from '../src/modules/mfa/mfa.service';
import { MagicLinkController } from '../src/modules/magic-link/magic-link.controller';
import { MagicLinkService } from '../src/modules/magic-link/magic-link.service';
import { AuthController } from '../src/modules/auth/auth.controller';
import { AuthService } from '../src/modules/auth/auth.service';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../src/common/prisma.service';

describe('rate limiting', () => {
  let app: INestApplication;
  let base: string;

  beforeAll(async () => {
    const mod = await Test.createTestingModule({
      imports: [ThrottlerModule.forRoot([{ ttl: 60_000, limit: 600 }])],
      controllers: [MfaController, MagicLinkController, AuthController],
      providers: [
        { provide: APP_GUARD, useClass: AppThrottlerGuard },
        { provide: MfaService, useValue: { challenge: async () => ({ ok: true }) } },
        { provide: MagicLinkService, useValue: { request: async () => {}, verify: async () => ({}) } },
        { provide: AuthService, useValue: {} },
        { provide: JwtService, useValue: new JwtService({ secret: 'x' }) },
        { provide: PrismaService, useValue: {} },
      ],
    }).compile();
    const nest = mod.createNestApplication<NestExpressApplication>();
    // Same setting as main.ts: one trusted proxy hop.
    nest.set('trust proxy', 1);
    await nest.listen(0);
    app = nest;
    const { port } = nest.getHttpServer().address() as AddressInfo;
    base = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await app?.close();
  });

  const post = (path: string, ip: string, body: unknown = {}) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
      body: JSON.stringify(body),
    });

  it('refuses the 11th MFA challenge attempt within a minute (429)', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) statuses.push((await post('/v1/me/mfa/challenge', '203.0.113.1', { code: '1' })).status);
    expect(statuses.slice(0, 10).every((s) => s < 400)).toBe(true);
    expect(statuses[10]).toBe(429);
  });

  it('keys limits on the real client IP behind one proxy hop', async () => {
    for (let i = 0; i < 10; i++) await post('/v1/me/mfa/challenge', '203.0.113.2', { code: '1' });
    expect((await post('/v1/me/mfa/challenge', '203.0.113.2', { code: '1' })).status).toBe(429);
    // A different client is unaffected.
    expect((await post('/v1/me/mfa/challenge', '203.0.113.3', { code: '1' })).status).toBeLessThan(400);
    // A spoofed left-most XFF entry does not change the key: the proxy's
    // appended (right-most) address is what counts.
    expect(
      (await post('/v1/me/mfa/challenge', '198.51.100.9, 203.0.113.2', { code: '1' })).status,
    ).toBe(429);
  });

  it('limits magic-link requests per IP', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) {
      statuses.push((await post('/v1/auth/magic-link/request', '203.0.113.4', { email: `a${i}@example.com` })).status);
    }
    expect(statuses.slice(0, 5).every((s) => s === 200)).toBe(true);
    expect(statuses[5]).toBe(429);
  });

  it('throttles the BFF exchange', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) statuses.push((await post('/v1/auth/exchange', '203.0.113.5', {})).status);
    expect(statuses[10]).toBe(429);
  });

  it('exempts webhooks, runner agents, and probes', () => {
    expect(isThrottleExemptPath('/v1/webhooks/github')).toBe(true);
    expect(isThrottleExemptPath('/v1/runner-agent/poll')).toBe(true);
    expect(isThrottleExemptPath('/healthz')).toBe(true);
    expect(isThrottleExemptPath('/v1/auth/exchange')).toBe(false);
    expect(isThrottleExemptPath('/v1/orgs/acme/runner-agents')).toBe(false);
  });
});
