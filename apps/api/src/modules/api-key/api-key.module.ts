import { Module } from '@nestjs/common';
import { CommonModule } from '../../common/common.module.js';
import { ApiKeyController } from './api-key.controller.js';
import { ApiKeyService } from './api-key.service.js';

@Module({
  imports: [CommonModule],
  controllers: [ApiKeyController],
  providers: [ApiKeyService],
  exports: [ApiKeyService],
})
export class ApiKeyModule {}
