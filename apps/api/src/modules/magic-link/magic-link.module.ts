import { Module } from '@nestjs/common';
import { CommonModule } from '../../common/common.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { MagicLinkController } from './magic-link.controller.js';
import { MagicLinkService } from './magic-link.service.js';

@Module({
  imports: [CommonModule, AuthModule],
  controllers: [MagicLinkController],
  providers: [MagicLinkService],
})
export class MagicLinkModule {}
