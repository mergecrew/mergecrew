import 'reflect-metadata';
// Postgres BIGINT columns surface as JS BigInt via Prisma; teach JSON how to
// emit them as strings so Express responses don't crash on serialization.
(BigInt.prototype as any).toJSON = function () { return this.toString(); };
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { JwtService } from '@nestjs/jwt';
import { AppModule } from './app.module.js';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter.js';
import { PrismaService } from './common/prisma.service.js';
import { stampUserContextOnRequest } from './common/tenant-context.service.js';
import type { Request, Response, NextFunction } from 'express';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    bodyParser: false,
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
    let userId: string | undefined;
    let mfaChallengedAt: Date | undefined;
    if (auth?.startsWith('Bearer ')) {
      try {
        const decoded = jwt.verify<{ sub: string; mfa_at?: number }>(auth.slice(7));
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

  const swagger = new DocumentBuilder()
    .setTitle('Mergecrew API')
    .setVersion('1.0.0')
    .addBearerAuth()
    .build();
  const doc = SwaggerModule.createDocument(app, swagger);
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
