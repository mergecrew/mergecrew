import { Controller, ForbiddenException, Headers, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import crypto from 'node:crypto';
import { QueueService } from '../../common/queue.service.js';

@Controller('v1/webhooks/sentry')
export class SentryWebhookController {
  constructor(private queue: QueueService) {}

  @Post()
  async receive(@Headers() headers: Record<string, string>, @Req() req: Request) {
    const body = (req as any).body as Buffer;
    if (!Buffer.isBuffer(body)) throw new ForbiddenException('expected raw body');

    const secret = process.env.SENTRY_CLIENT_SECRET;
    if (!secret) throw new ForbiddenException('sentry client secret not configured');

    // Sentry sends sha256 HMAC in `sentry-hook-signature` (lowercase header).
    const sig = headers['sentry-hook-signature'];
    if (!sig) throw new ForbiddenException('missing sentry-hook-signature');
    const expected = crypto.createHmac('sha256', secret).update(body).digest('hex');
    const a = Buffer.from(expected);
    const b = Buffer.from(sig);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      throw new ForbiddenException('invalid sentry signature');
    }

    let parsed: unknown = {};
    try {
      parsed = JSON.parse(body.toString('utf8'));
    } catch {
      // ignore
    }
    const resource = headers['sentry-hook-resource'];
    await this.queue
      .get('webhook.inbound')
      .add('sentry', { event: parsed, resource }, { removeOnComplete: 5000, removeOnFail: 1000 });
    return { ok: true };
  }
}
