import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { IsString, IsEmail, IsUrl, MaxLength } from 'class-validator';
import { MagicLinkService } from './magic-link.service.js';

class RequestDto {
  @IsEmail()
  @MaxLength(254)
  email!: string;

  @IsUrl({ require_protocol: true, require_tld: false })
  @MaxLength(2048)
  callbackUrl!: string;
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
  async request(@Body() body: RequestDto) {
    await this.magicLink.request(body);
    // Always 200 — never reveal whether an account exists.
    return { ok: true };
  }

  @Post('verify')
  @HttpCode(200)
  async verify(@Body() body: VerifyDto) {
    return this.magicLink.verify(body);
  }
}
