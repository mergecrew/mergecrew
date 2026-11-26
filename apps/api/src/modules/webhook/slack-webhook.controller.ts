import { Controller, ForbiddenException, Headers, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { QueueService } from '../../common/queue.service.js';
import { requireRawBody, requireWebhookSecret, verifySlackSignature } from './signature.js';

@Controller('v1/webhooks/slack/interactivity')
export class SlackWebhookController {
  constructor(private queue: QueueService) {}

  @Post()
  async receive(@Headers() headers: Record<string, string>, @Req() req: Request) {
    const body = requireRawBody((req as any).body);
    const secret = requireWebhookSecret('SLACK_SIGNING_SECRET', 'slack');

    if (!headers['x-slack-request-timestamp'] || !headers['x-slack-signature']) {
      throw new ForbiddenException('missing slack signature headers');
    }
    // Checks the 5-minute timestamp window and the v0 HMAC.
    if (!verifySlackSignature(headers, body, secret)) {
      throw new ForbiddenException('invalid slack signature');
    }

    // Slack sends form-encoded payload with a JSON `payload` field.
    const params = new URLSearchParams(body.toString('utf8'));
    const payload = params.get('payload');
    if (!payload) return { ok: true };
    let parsed: unknown = {};
    try {
      parsed = JSON.parse(payload);
    } catch {
      /* ignore */
    }
    await this.queue
      .get('webhook.inbound')
      .add('slack', { event: parsed }, { removeOnComplete: 5000, removeOnFail: 1000 });
    return { ok: true };
  }
}
