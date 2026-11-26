import { Controller, ForbiddenException, Headers, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { QueueService } from '../../common/queue.service.js';
import { requireRawBody, requireWebhookSecret, verifySentrySignature } from './signature.js';

@Controller('v1/webhooks/sentry')
export class SentryWebhookController {
  constructor(private queue: QueueService) {}

  @Post()
  async receive(@Headers() headers: Record<string, string>, @Req() req: Request) {
    const body = requireRawBody((req as any).body);
    const secret = requireWebhookSecret('SENTRY_CLIENT_SECRET', 'sentry');

    // Sentry sends sha256 HMAC in `sentry-hook-signature` (lowercase header).
    if (!headers['sentry-hook-signature']) throw new ForbiddenException('missing sentry-hook-signature');
    if (!verifySentrySignature(headers, body, secret)) {
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
