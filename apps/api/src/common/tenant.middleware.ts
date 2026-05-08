import { Injectable, NestMiddleware, NotFoundException, UnauthorizedException } from '@nestjs/common';
import type { Request, Response, NextFunction } from 'express';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from './prisma.service.js';
import { stampUserContextOnRequest } from './tenant-context.service.js';

@Injectable()
export class TenantMiddleware implements NestMiddleware {
  private jwt: JwtService;
  constructor(private prisma: PrismaService, config: ConfigService) {
    this.jwt = new JwtService({ secret: config.get<string>('JWT_SECRET') ?? 'dev-secret' });
  }

  async use(req: Request, _res: Response, next: NextFunction): Promise<void> {
    if (!/^\/v1\/orgs(\/|$)/.test(req.path)) {
      next();
      return;
    }

    const auth = req.headers.authorization;
    let userId: string | undefined;
    if (auth?.startsWith('Bearer ')) {
      try {
        const decoded = this.jwt.verify<{ sub: string }>(auth.slice(7));
        userId = decoded.sub;
      } catch {
        // fall through; BFF may identify via header
      }
    }
    const cookieUid = req.headers['x-mergecrew-user-id'];
    if (!userId && typeof cookieUid === 'string') userId = cookieUid;
    if (!userId) throw new UnauthorizedException();

    const m = req.path.match(/^\/v1\/orgs\/([^/]+)/);
    if (!m) {
      stampUserContextOnRequest(req, { userId });
      next();
      return;
    }

    const slug = decodeURIComponent(m[1]!);
    const org = await this.prisma.withSystem((tx) =>
      tx.organization.findFirst({ where: { slug, deletedAt: null } }),
    );
    if (!org) throw new NotFoundException();

    const membership = await this.prisma.withSystem((tx) =>
      tx.membership.findFirst({ where: { organizationId: org.id, userId } }),
    );
    if (!membership) throw new NotFoundException();

    stampUserContextOnRequest(req, {
      userId,
      tenant: {
        organizationId: org.id,
        organizationSlug: org.slug,
        userId,
        role: membership.role,
      },
    });
    next();
  }
}
