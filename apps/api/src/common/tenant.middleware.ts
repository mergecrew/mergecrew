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

    // Validate the JWT/header sub still references a real user. Without
    // this check, a JWT minted before a `docker compose down -v` (signed
    // with the same dev-secret but naming a now-deleted user) would fall
    // through to a downstream Prisma P2003 — e.g. memberships_user_id_fkey
    // on org create — surfacing as an unhandled 500 instead of a 401.
    // Wrap in try/catch so a malformed-uuid JWT also normalizes to 401.
    let userExists: { id: string } | null = null;
    try {
      userExists = await this.prisma.withSystem((tx) =>
        tx.user.findUnique({ where: { id: userId }, select: { id: true } }),
      );
    } catch {
      userExists = null;
    }
    if (!userExists) {
      throw new UnauthorizedException({
        code: 'STALE_SESSION',
        message: 'session user no longer exists — sign in again',
      });
    }

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
