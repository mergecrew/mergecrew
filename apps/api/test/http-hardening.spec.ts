import 'reflect-metadata';
import { Controller, Get, Module, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NextFunction, Request, Response } from 'express';
import {
  enableCaseSensitiveRouting,
  isAuthedIntegrationPath,
  isMePath,
  isOrgPath,
  requiresAuthentication,
} from '../src/common/auth-paths';
import { UNMATCHED_ROUTE_LABEL, routeLabel } from '../src/modules/health/metrics';
import { isMetricsRequestAllowed, isPrivateAddress } from '../src/modules/health/metrics-access';

describe('auth path classification', () => {
  it('is case-insensitive', () => {
    for (const p of ['/v1/orgs', '/v1/orgs/acme', '/V1/orgs/acme', '/v1/ORGS/acme/projects', '/V1/ORGS']) {
      expect(isOrgPath(p)).toBe(true);
    }
    for (const p of ['/v1/me', '/v1/ME/mfa', '/V1/me/notifications']) expect(isMePath(p)).toBe(true);
    expect(isAuthedIntegrationPath('/V1/integrations/github/INSTALL')).toBe(true);
    expect(isAuthedIntegrationPath('/v1/integrations/github/install/')).toBe(true);
    expect(isAuthedIntegrationPath('/v1/integrations/github/install/callback')).toBe(false);
    expect(requiresAuthentication('/v1/auth/login')).toBe(false);
    expect(requiresAuthentication('/v1/orgsx')).toBe(false);
  });
});

@Controller('v1/orgs/:slug')
class OrgProbeController {
  @Get('ping')
  ping() {
    return { ok: true };
  }
}

@Module({ controllers: [OrgProbeController] })
class ProbeModule {}

describe('routing + auth middleware wiring', () => {
  let app: INestApplication;
  let base: string;
  const labels = new Set<string>();

  beforeAll(async () => {
    app = await NestFactory.create(ProbeModule, { logger: false });
    enableCaseSensitiveRouting(app);
    // Mirrors main.ts: metrics label + auth gate keyed on requiresAuthentication.
    app.use((req: Request, res: Response, next: NextFunction) => {
      res.on('finish', () => labels.add(routeLabel(req as any)));
      next();
    });
    app.use((req: Request, res: Response, next: NextFunction) => {
      if (requiresAuthentication(req.path) && req.headers.authorization !== 'Bearer ok') {
        res.status(401).json({ error: { code: 'UNAUTHORIZED' } });
        return;
      }
      next();
    });
    await app.listen(0, '127.0.0.1');
    const addr = app.getHttpServer().address();
    base = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    await app.close();
  });

  it('upper-cased org paths are authenticated (401), not routed around the middleware', async () => {
    expect((await fetch(`${base}/V1/orgs/x/ping`)).status).toBe(401);
    expect((await fetch(`${base}/v1/ORGS/x/ping`)).status).toBe(401);
  });

  it('case-variant paths never reach the controller even when authenticated', async () => {
    const auth = { headers: { authorization: 'Bearer ok' } };
    expect((await fetch(`${base}/v1/orgs/x/ping`, auth)).status).toBe(200);
    expect((await fetch(`${base}/V1/orgs/x/ping`, auth)).status).toBe(404);
    expect((await fetch(`${base}/v1/orgs/x/PING`, auth)).status).toBe(404);
  });

  it('unmatched paths collapse into a single metrics route label', async () => {
    labels.clear();
    for (const p of ['/wp-login.php', '/www/.env', '/a/b/c', '/v1/nope/123']) await fetch(`${base}${p}`);
    await fetch(`${base}/v1/orgs/acme/ping`, { headers: { authorization: 'Bearer ok' } });
    await new Promise((r) => setTimeout(r, 20));
    expect(labels).toEqual(new Set([UNMATCHED_ROUTE_LABEL, '/v1/orgs/:slug/ping']));
  });
});

describe('/metrics access policy', () => {
  const req = (remoteAddress: string, headers: Record<string, string> = {}) => ({
    headers,
    socket: { remoteAddress },
  });

  it('allows internal scrapers without proxy headers', () => {
    expect(isMetricsRequestAllowed(req('10.0.0.5'), {})).toBe(true);
    expect(isMetricsRequestAllowed(req('::ffff:172.18.0.3'), {})).toBe(true);
    expect(isMetricsRequestAllowed(req('::1'), {})).toBe(true);
  });

  it('rejects public peers and anything relayed by a reverse proxy', () => {
    expect(isMetricsRequestAllowed(req('203.0.113.7'), {})).toBe(false);
    expect(isMetricsRequestAllowed(req('172.18.0.2', { 'x-forwarded-for': '203.0.113.7' }), {})).toBe(false);
    expect(isMetricsRequestAllowed(req('127.0.0.1', { forwarded: 'for=203.0.113.7' }), {})).toBe(false);
  });

  it('accepts a matching METRICS_TOKEN bearer from anywhere and rejects a wrong one', () => {
    const env = { METRICS_TOKEN: 's3cret-token' };
    expect(
      isMetricsRequestAllowed(
        req('203.0.113.7', { authorization: 'Bearer s3cret-token', 'x-forwarded-for': '1.1.1.1' }),
        env,
      ),
    ).toBe(true);
    expect(isMetricsRequestAllowed(req('203.0.113.7', { authorization: 'Bearer nope' }), env)).toBe(false);
  });

  it('classifies private ranges', () => {
    expect(isPrivateAddress('192.168.1.1')).toBe(true);
    expect(isPrivateAddress('172.32.0.1')).toBe(false);
    expect(isPrivateAddress('fd12::1')).toBe(true);
    expect(isPrivateAddress('2001:db8::1')).toBe(false);
    expect(isPrivateAddress(undefined)).toBe(false);
  });
});
