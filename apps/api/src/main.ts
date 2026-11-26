import 'reflect-metadata';
// Postgres BIGINT columns surface as JS BigInt via Prisma; teach JSON how to
// emit them as strings so Express responses don't crash on serialization.
(BigInt.prototype as any).toJSON = function () { return this.toString(); };
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { SwaggerModule } from '@nestjs/swagger';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { JwtService } from '@nestjs/jwt';
import { AppModule } from './app.module.js';
import { buildOpenApiDocumentConfig } from './openapi-config.js';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter.js';
import { PrismaService } from './common/prisma.service.js';
import { stampUserContextOnRequest } from './common/tenant-context.service.js';
import { API_KEY_PREFIX, apiKeyCreatorStillAuthorized, hashToken } from './modules/api-key/api-key.service.js';
import { assertProductionSecrets, jwtSecret } from './common/secrets.js';
import { checkSessionToken, isMfaChallengeRoute } from './common/session-token.js';
import {
  ORG_SLUG_RE,
  enableCaseSensitiveRouting,
  isAuthedIntegrationPath as isAuthedIntegrationRoute,
  isMePath as isMeRoute,
  isOrgPath as isOrgRoute,
} from './common/auth-paths.js';
import {
  httpRequestDurationSeconds,
  httpRequestsTotal,
  initMetrics,
  routeLabel,
} from './modules/health/metrics.js';
import type { Request, Response, NextFunction } from 'express';

async function bootstrap() {
  // Fail closed before anything else: no production boot with missing or
  // publicly known JWT / BFF / KMS secrets.
  assertProductionSecrets();
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bodyParser: false,
  });
  // Caddy is the single reverse proxy in front of the API (and the web BFF
  // forwards the browser's address on its server-side calls), so trust
  // exactly one hop: req.ip is then the real client for rate limiting.
  app.set('trust proxy', 1);
  // `/V1/orgs/...` must not reach `/v1/orgs/...` controllers.
  enableCaseSensitiveRouting(app);

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
      // Use `req.route?.path` (the route template) when NestJS resolved a
      // controller route. Unmatched requests share one fixed label so a
      // path scan can't grow the series count without bound.
      const route = routeLabel(req as Request & { route?: { path?: unknown } });
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
  // matching is reliable. Resolves user from the Bearer JWT only and, for
  // org-scoped paths, the membership and role. Identity is never taken from a
  // client-supplied header: an `x-mergecrew-user-id` fallback here let any
  // caller act as any user whose id they knew.
  const prisma = app.get(PrismaService);
  const jwt = new JwtService({ secret: jwtSecret() });

  app.use(async (req: Request, res: Response, next: NextFunction) => {
    // Routes requiring an authenticated user but not necessarily a tenant:
    // /v1/orgs/* (tenant) and /v1/me/* (user-scoped self-service like MFA).
    // The GitHub App install entrypoint (#459) is the third — it isn't
    // org-path-scoped (the org slug comes from the `org` query param),
    // but it needs `this.tenant.user()` to mint the state HMAC. The
    // matching callback path stays public so GitHub's redirect can land.
    // Matching is case-insensitive (see common/auth-paths.ts) so `/V1/...`
    // can't skip authentication.
    const isOrgPath = isOrgRoute(req.path);
    const isMePath = isMeRoute(req.path);
    const isAuthedIntegrationPath = isAuthedIntegrationRoute(req.path);
    if (!isOrgPath && !isMePath && !isAuthedIntegrationPath) {
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
        // Keys act on behalf of their creator: reject once the creator is
        // no longer a member with at least the key's role.
        if (!(await apiKeyCreatorStillAuthorized(prisma, row))) {
          res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'invalid api key' } });
          return;
        }
        const m = req.path.match(ORG_SLUG_RE);
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

    // Signature, revocation (token version), and MFA-completion checks
    // live in common/session-token.ts so whoami applies the same rules.
    let session;
    try {
      session = await checkSessionToken({
        jwt,
        token: bearer,
        allowMfaPending: isMfaChallengeRoute(req.method, req.path),
        loadUser: (id) =>
          prisma.withSystem((tx) =>
            tx.user.findUnique({
              where: { id },
              select: { tokenVersion: true, mfaEnrolledAt: true },
            }),
          ),
      });
    } catch (err) {
      next(err);
      return;
    }
    if (!session.ok) {
      res.status(401).json({ error: { code: session.code, message: session.message } });
      return;
    }
    const { userId, mfaChallengedAt, mfaEnrolled } = session;

    const m = req.path.match(ORG_SLUG_RE);
    if (!m) {
      // /v1/me/* (or any other user-only route).
      stampUserContextOnRequest(req, { userId, mfaChallengedAt, mfaEnrolled });
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
        mfaEnrolled,
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

bootstrap().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[api] bootstrap failed', err);
  process.exit(1);
});
