import { Module } from '@nestjs/common';
import { CommonModule } from '../../common/common.module.js';
import { OutboundWebhookController } from './outbound-webhook.controller.js';
import { OutboundWebhookService } from './outbound-webhook.service.js';

@Module({
  imports: [CommonModule],
  controllers: [OutboundWebhookController],
  providers: [OutboundWebhookService],
  exports: [OutboundWebhookService],
})
export class OutboundWebhookModule {}
