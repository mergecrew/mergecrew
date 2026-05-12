import 'reflect-metadata';
// Postgres BIGINT columns surface as JS BigInt via Prisma; teach JSON how to
// emit them as strings so Express responses don't crash on serialization.
(BigInt.prototype as any).toJSON = function () { return this.toString(); };
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { SwaggerModule } from '@nestjs/swagger';
import { JwtService } from '@nestjs/jwt';
import { AppModule } from './app.module.js';
import { buildOpenApiDocumentConfig } from './openapi-config.js';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter.js';
import { PrismaService } from './common/prisma.service.js';
import { stampUserContextOnRequest } from './common/tenant-context.service.js';
import { API_KEY_PREFIX, hashToken } from './modules/api-key/api-key.service.js';
import {
  httpRequestDurationSeconds,
  httpRequestsTotal,
  initMetrics,
} from './modules/health/metrics.js';
import type { Request, Response, NextFunction } from 'express';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    bodyParser: false,
  });

  // Metrics: initialize registry + default node/process collectors. The
  // request-timing middleware below feeds the per-route histogram +
  // counter; /metrics on the HealthController serves the exposition.
  initMetrics({ service: 'api' });
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (req.path === '/metrics' || req.path === '/healthz' || req.path === '/readyz') {
      next();
      return;
    }
    const startNs = process.hrtime.bigint();
    res.on('finish', () => {
      const durationSec = Number(process.hrtime.bigint() - startNs) / 1e9;
      // Use `req.route?.path` when NestJS resolved a controller route, fall
      // back to a normalized path so we don't unbounded-cardinality the
      // labels with raw `/v1/orgs/abc-123` ids.
      const route = (req as Request & { route?: { path?: string } }).route?.path ?? normalizeRoute(req.path);
      const status = `${Math.floor(res.statusCode / 100)}xx`;
      const labels = { method: req.method, route, status };
      httpRequestsTotal.inc(labels);
      httpRequestDurationSeconds.observe(labels, durationSec);
    });
    next();
  });

  app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true }));
  app.useGlobalFilters(new AllExceptionsFilter());
  app.enableCors({
    origin: process.env.WEB_BASE_URL ?? 'http://localhost:3000',
    credentials: true,
  });

  // Tenant middleware: registered as plain Express middleware so the path
  // matching is reliable. Resolves user from Bearer JWT (or x-mergecrew-user-id
  // header in dev) and, for org-scoped paths, the membership and role.
  const prisma = app.get(PrismaService);
  const jwt = new JwtService({ secret: process.env.JWT_SECRET ?? 'dev-secret' });

  app.use(async (req: Request, res: Response, next: NextFunction) => {
    // Routes requiring an authenticated user but not necessarily a tenant:
    // /v1/orgs/* (tenant) and /v1/me/* (user-scoped self-service like MFA).
    const isOrgPath = /^\/v1\/orgs(\/|$)/.test(req.path);
    const isMePath = /^\/v1\/me(\/|$)/.test(req.path);
    if (!isOrgPath && !isMePath) {
      next();
      return;
    }
    const auth = req.headers.authorization;
    const bearer = auth?.startsWith('Bearer ') ? auth.slice(7) : undefined;

    // API-key path: Bearer mc_live_<secret>. Looks up the row by the
    // sha256(token) digest the DB indexes; on hit, stamps a synthetic
    // user context with the key's stored role and bypasses the membership
    // check (the org link lives on the api_key row itself).
    if (bearer?.startsWith(API_KEY_PREFIX)) {
      try {
        const row = await prisma.withSystem((tx) =>
          tx.apiKey.findUnique({ where: { tokenHash: hashToken(bearer) } }),
        );
        if (!row || row.revokedAt) {
          res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'invalid api key' } });
          return;
        }
        const m = req.path.match(/^\/v1\/orgs\/([^/]+)/);
        if (m) {
          const slug = decodeURIComponent(m[1]!);
          const org = await prisma.withSystem((tx) =>
            tx.organization.findFirst({ where: { slug, deletedAt: null } }),
          );
          if (!org || org.id !== row.organizationId) {
            res.status(404).json({ error: { code: 'NOT_FOUND', message: 'org not found' } });
            return;
          }
          // Best-effort lastUsedAt update; don't block the request on it.
          void prisma
            .withSystem((tx) => tx.apiKey.update({ where: { id: row.id }, data: { lastUsedAt: new Date() } }))
            .catch(() => {});
          stampUserContextOnRequest(req, {
            userId: row.createdByUserId ?? row.id,
            apiKeyId: row.id,
            tenant: {
              organizationId: org.id,
              organizationSlug: org.slug,
              userId: row.createdByUserId ?? row.id,
              role: row.role as any,
            },
          });
          next();
          return;
        }
        // /v1/me/* with an API key: no MFA setup over API keys, so reject
        // here rather than offering a partial principal.
        res.status(403).json({ error: { code: 'FORBIDDEN', message: 'api keys cannot access /v1/me/*' } });
        return;
      } catch (err) {
        next(err);
        return;
      }
    }

    let userId: string | undefined;
    let mfaChallengedAt: Date | undefined;
    if (bearer) {
      try {
        const decoded = jwt.verify<{ sub: string; mfa_at?: number }>(bearer);
        userId = decoded.sub;
        if (typeof decoded.mfa_at === 'number') {
          mfaChallengedAt = new Date(decoded.mfa_at * 1000);
        }
      } catch {
        // fall through
      }
    }
    const cookieUid = req.headers['x-mergecrew-user-id'];
    if (!userId && typeof cookieUid === 'string') userId = cookieUid;
    if (!userId) {
      res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'unauthorized' } });
      return;
    }

    const m = req.path.match(/^\/v1\/orgs\/([^/]+)/);
    if (!m) {
      // /v1/me/* (or any other user-only route).
      stampUserContextOnRequest(req, { userId, mfaChallengedAt });
      next();
      return;
    }
    const slug = decodeURIComponent(m[1]!);
    try {
      const org = await prisma.withSystem((tx) =>
        tx.organization.findFirst({ where: { slug, deletedAt: null } }),
      );
      if (!org) {
        res.status(404).json({ error: { code: 'NOT_FOUND', message: 'org not found' } });
        return;
      }
      const membership = await prisma.withSystem((tx) =>
        tx.membership.findFirst({ where: { organizationId: org.id, userId } }),
      );
      if (!membership) {
        res.status(404).json({ error: { code: 'NOT_FOUND', message: 'org not found' } });
        return;
      }
      stampUserContextOnRequest(req, {
        userId,
        mfaChallengedAt,
        tenant: {
          organizationId: org.id,
          organizationSlug: org.slug,
          userId,
          role: membership.role,
        },
      });
      next();
    } catch (err) {
      next(err);
    }
  });

  const doc = SwaggerModule.createDocument(app, buildOpenApiDocumentConfig());
  SwaggerModule.setup('v1/openapi', app, doc, {
    jsonDocumentUrl: 'v1/openapi.json',
  });

  const port = Number(process.env.API_PORT ?? 4000);
  await app.listen(port);
  // eslint-disable-next-line no-console
  console.log(`[api] listening on :${port}`);
}

// Collapse uuid / slug / numeric segments so the `route` label stays bounded.
// Anything that survives matches a real route shape — `/v1/orgs/:slug/...`.
function normalizeRoute(path: string): string {
  return path
    .replace(/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '/:uuid')
    .replace(/\/\d+/g, '/:id');
}

bootstrap().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[api] bootstrap failed', err);
  process.exit(1);
});
