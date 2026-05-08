import { Body, Controller, Get, Post, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { AuthService } from './auth.service.js';

/**
 * Auth surface. The Next.js BFF holds the user-facing OAuth/credentials flow
 * via NextAuth, and forwards an authenticated identity to the API. This
 * controller is what the BFF talks to once a user is authenticated.
 */
@Controller('v1/auth')
export class AuthController {
  constructor(private auth: AuthService, private jwt: JwtService) {}

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
}
