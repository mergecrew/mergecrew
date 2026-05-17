import { Body, Controller, Get, Headers, Post, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { AuthService } from './auth.service.js';
import { PrismaService } from '../../common/prisma.service.js';

/**
 * Auth surface. The Next.js BFF holds the user-facing OAuth/credentials flow
 * via NextAuth, and forwards an authenticated identity to the API. This
 * controller is what the BFF talks to once a user is authenticated.
 */
@Controller('v1/auth')
export class AuthController {
  constructor(
    private auth: AuthService,
    private jwt: JwtService,
    private prisma: PrismaService,
  ) {}

  /** Exchange a BFF-trusted email assertion for a JWT. The BFF must be running on the trusted network. */
  @Post('exchange')
  async exchange(@Body() body: { email: string; name?: string; avatarUrl?: string; trustToken?: string }) {
    if (!body.email) throw new UnauthorizedException();
    const trust = process.env.BFF_TRUST_TOKEN ?? 'dev-trust-token';
    if (body.trustToken !== trust) throw new UnauthorizedException();
    const user = await this.auth.findOrCreateByEmail(body.email, body.name, body.avatarUrl);
    const token = this.auth.signSessionJwt(user.id);
    return { token, user: { id: user.id, email: user.email, name: user.name } };
  }

  @Get('session')
  async session(@Body() _b: any) {
    // The BFF passes the user id via the Authorization Bearer JWT.
    // Decoding here is BFF's job; we return shaped data given a sub.
    return { ok: true };
  }

  /**
   * Cheap "is this JWT still valid for a real user?" probe. Used by the
   * BFF's edge middleware to detect cookies left over from a prior DB
   * (post-`docker compose down -v`) and clear them, rather than letting
   * a downstream request 500 on `memberships_user_id_fkey`. Returns
   * 401 `STALE_SESSION` when the JWT decodes but its `sub` no longer
   * exists; 401 `UNAUTHORIZED` for missing/invalid JWTs.
   */
  @Get('whoami')
  async whoami(@Headers('authorization') authHeader?: string) {
    if (!authHeader?.startsWith('Bearer ')) throw new UnauthorizedException();
    let sub: string;
    try {
      sub = this.jwt.verify<{ sub: string }>(authHeader.slice(7)).sub;
    } catch {
      throw new UnauthorizedException();
    }
    let user: { id: string; email: string; name: string | null } | null = null;
    try {
      user = await this.prisma.client().user.findUnique({
        where: { id: sub },
        select: { id: true, email: true, name: true },
      });
    } catch {
      user = null;
    }
    if (!user) {
      throw new UnauthorizedException({
        code: 'STALE_SESSION',
        message: 'session user no longer exists — sign in again',
      });
    }
    return { userId: user.id, email: user.email, name: user.name };
  }
}
