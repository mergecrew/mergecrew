import { Body, Controller, Get, Headers, HttpCode, Post, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Throttle } from '@nestjs/throttler';
import { AuthService } from './auth.service.js';
import { PrismaService } from '../../common/prisma.service.js';
import { bffTrustToken, safeEqual } from '../../common/secrets.js';
import { checkSessionToken, type SessionClaims } from '../../common/session-token.js';
import { AUTH_STRICT_THROTTLE } from '../../common/throttle.js';

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

  /**
   * Exchange a BFF-trusted email assertion for a JWT. The BFF must be
   * running on the trusted network and only calls this after the OAuth
   * provider has confirmed the address is verified (web `signIn` callback).
   *
   * MFA-enrolled users get `{ mfaRequired, mfaToken }` instead of a session;
   * the BFF sends them to the TOTP challenge.
   */
  @Post('exchange')
  @HttpCode(201)
  @Throttle(AUTH_STRICT_THROTTLE)
  async exchange(@Body() body: { email: string; name?: string; avatarUrl?: string; trustToken?: string }) {
    if (!safeEqual(body?.trustToken, bffTrustToken())) throw new UnauthorizedException();
    if (!body.email || typeof body.email !== 'string') throw new UnauthorizedException();
    const user = await this.auth.findOrCreateByEmail(body.email, body.name, body.avatarUrl);
    return this.auth.issueLogin(user);
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
   * (post-`docker compose down -v`) or a revoked session and clear them.
   * Returns 401 `STALE_SESSION` when the JWT decodes but its `sub` no
   * longer exists, `SESSION_REVOKED` after sign-out, `UNAUTHORIZED` for
   * missing/invalid JWTs.
   */
  @Get('whoami')
  async whoami(@Headers('authorization') authHeader?: string) {
    const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : undefined;
    const check = await checkSessionToken({
      jwt: this.jwt,
      token,
      loadUser: (id) => this.loadSessionUser(id),
    });
    if (!check.ok) throw new UnauthorizedException({ code: check.code, message: check.message });
    const user = await this.prisma.withSystem((tx) =>
      tx.user.findUnique({ where: { id: check.userId }, select: { id: true, email: true, name: true } }),
    );
    if (!user) throw new UnauthorizedException({ code: 'STALE_SESSION' });
    return { userId: user.id, email: user.email, name: user.name };
  }

  /**
   * Sign out: revoke every outstanding session JWT for the caller by
   * bumping their token version. Accepts a pre-MFA token too so an
   * abandoned challenge can be cancelled. Idempotent for already-invalid
   * tokens (returns 204 without doing anything).
   */
  @Post('logout')
  @HttpCode(204)
  async logout(@Headers('authorization') authHeader?: string): Promise<void> {
    const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : undefined;
    if (!token) return;
    let claims: SessionClaims;
    try {
      claims = this.jwt.verify<SessionClaims>(token);
    } catch {
      return;
    }
    if (typeof claims?.sub !== 'string') return;
    let user: { tokenVersion: number } | null = null;
    try {
      user = await this.loadSessionUser(claims.sub);
    } catch {
      user = null;
    }
    // Only a token that is still current may revoke; replaying an old
    // token after sign-out is a no-op.
    if (!user || (claims.tv ?? 0) !== user.tokenVersion) return;
    await this.auth.revokeSessions(claims.sub);
  }

  private loadSessionUser(id: string) {
    return this.prisma.withSystem((tx) =>
      tx.user.findUnique({ where: { id }, select: { tokenVersion: true, mfaEnrolledAt: true } }),
    );
  }
}
