import { Body, Controller, Get, Post } from '@nestjs/common';
import { MfaService } from './mfa.service.js';

@Controller('v1/me/mfa')
export class MfaController {
  constructor(private mfa: MfaService) {}

  @Get()
  async status() {
    return this.mfa.status();
  }

  @Post('setup')
  async setup() {
    return this.mfa.setup();
  }

  @Post('verify')
  async verify(@Body() body: { code: string }) {
    return this.mfa.verify(body);
  }

  @Post('disable')
  async disable(@Body() body: { code: string }) {
    await this.mfa.disable(body);
    return { ok: true };
  }

  @Post('recovery-codes/regenerate')
  async regenerateRecoveryCodes(@Body() body: { code: string }) {
    return this.mfa.regenerateRecoveryCodes(body);
  }
}
