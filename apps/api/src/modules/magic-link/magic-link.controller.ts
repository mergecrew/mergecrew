import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { IsString, IsEmail, IsOptional, MaxLength } from 'class-validator';
import { Throttle } from '@nestjs/throttler';
import { MagicLinkService } from './magic-link.service.js';
import { AUTH_STRICT_THROTTLE, MAGIC_LINK_REQUEST_THROTTLE } from '../../common/throttle.js';

class RequestDto {
  @IsEmail()
  @MaxLength(254)
  email!: string;

  /** Ignored — kept so older web builds that still send it don't 400. */
  @IsOptional()
  @IsString()
  @MaxLength(2048)
  callbackUrl?: string;
}

class VerifyDto {
  @IsEmail()
  @MaxLength(254)
  email!: string;

  @IsString()
  @MaxLength(512)
  token!: string;
}

/**
 * Magic-link auth endpoints (#1). Public — no tenant context, no JWT
 * required. The BFF (apps/web) routes /login → request, and a server
 * route handler at /api/auth/magic-link → verify, then sets the
 * mergecrew_jwt cookie and redirects to /.
 */
@Controller('v1/auth/magic-link')
export class MagicLinkController {
  constructor(private magicLink: MagicLinkService) {}

  @Post('request')
  @HttpCode(200)
  @Throttle(MAGIC_LINK_REQUEST_THROTTLE)
  async request(@Body() body: RequestDto) {
    await this.magicLink.request({ email: body.email });
    // Always 200 — never reveal whether an account exists.
    return { ok: true };
  }

  @Post('verify')
  @HttpCode(200)
  @Throttle(AUTH_STRICT_THROTTLE)
  async verify(@Body() body: VerifyDto) {
    return this.magicLink.verify(body);
  }
}
