import { Controller, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { QueueService } from '../../common/queue.service.js';

@Controller('v1/webhooks/sentry')
export class SentryWebhookController {
  constructor(private queue: QueueService) {}

  @Post()
  async receive(@Req() req: Request) {
    const body = (req as any).body as Buffer;
    let parsed: unknown = {};
    try {
      parsed = JSON.parse(body.toString('utf8'));
    } catch {
      // ignore
    }
    await this.queue.get('webhook.inbound').add('sentry', { event: parsed }, { removeOnComplete: 5000 });
    return { ok: true };
  }
}
