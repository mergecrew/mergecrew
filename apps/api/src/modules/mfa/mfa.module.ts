import { Module } from '@nestjs/common';
import { CommonModule } from '../../common/common.module.js';
import { MfaController } from './mfa.controller.js';
import { MfaService } from './mfa.service.js';

@Module({
  imports: [CommonModule],
  controllers: [MfaController],
  providers: [MfaService],
})
export class MfaModule {}
