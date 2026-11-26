import { Controller, ForbiddenException, Headers, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { QueueService } from '../../common/queue.service.js';
import { requireRawBody, requireWebhookSecret, verifyLinearWebhook } from './signature.js';

/**
 * Linear webhook receiver. Requires `LINEAR_WEBHOOK_SECRET` (the signing
 * secret from the Linear webhook's settings page); without it every
 * request is rejected.
 */
@Controller('v1/webhooks/linear')
export class LinearWebhookController {
  constructor(private queue: QueueService) {}

  @Post()
  async receive(@Headers() headers: Record<string, string>, @Req() req: Request) {
    const body = requireRawBody((req as any).body);
    const secret = requireWebhookSecret('LINEAR_WEBHOOK_SECRET', 'linear');
    const parsed = verifyLinearWebhook(headers, body, secret);
    if (!parsed) throw new ForbiddenException('invalid linear signature');
    await this.queue.get('webhook.inbound').add('linear', { event: parsed }, { removeOnComplete: 5000 });
    return { ok: true };
  }
}
