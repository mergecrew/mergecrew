import { Body, Controller, Get, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { MfaService } from './mfa.service.js';
import { MFA_CODE_THROTTLE } from '../../common/throttle.js';

@Controller('v1/me/mfa')
export class MfaController {
  constructor(private mfa: MfaService) {}

  @Get()
  async status() {
    return this.mfa.status();
  }

  /**
   * Start (or restart) enrolment. When MFA is already enrolled, `code`
   * (current TOTP or a recovery code) is required.
   */
  @Post('setup')
  @Throttle(MFA_CODE_THROTTLE)
  async setup(@Body() body: { force?: boolean; code?: string } = {}) {
    return this.mfa.setup({
      force: !!body?.force,
      ...(typeof body?.code === 'string' ? { code: body.code } : {}),
    });
  }

  @Post('verify')
  @Throttle(MFA_CODE_THROTTLE)
  async verify(@Body() body: { code: string }) {
    return this.mfa.verify(body);
  }

  @Post('disable')
  @Throttle(MFA_CODE_THROTTLE)
  async disable(@Body() body: { code: string }) {
    await this.mfa.disable(body);
    return { ok: true };
  }

  @Post('challenge')
  @Throttle(MFA_CODE_THROTTLE)
  async challenge(@Body() body: { code: string }) {
    return this.mfa.challenge(body);
  }

  @Post('recovery-codes/regenerate')
  @Throttle(MFA_CODE_THROTTLE)
  async regenerateRecoveryCodes(@Body() body: { code: string }) {
    return this.mfa.regenerateRecoveryCodes(body);
  }
}
