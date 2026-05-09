import { Module } from '@nestjs/common';
import { CommonModule } from '../../common/common.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { MfaController } from './mfa.controller.js';
import { MfaService } from './mfa.service.js';

@Module({
  imports: [CommonModule, AuthModule],
  controllers: [MfaController],
  providers: [MfaService],
  exports: [MfaService],
})
export class MfaModule {}
