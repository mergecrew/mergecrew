import { Controller, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { QueueService } from '../../common/queue.service.js';

@Controller('v1/webhooks/slack/interactivity')
export class SlackWebhookController {
  constructor(private queue: QueueService) {}

  @Post()
  async receive(@Req() req: Request) {
    const body = (req as any).body as Buffer;
    // Slack sends form-encoded payload with a JSON `payload` field.
    const text = body.toString('utf8');
    const params = new URLSearchParams(text);
    const payload = params.get('payload');
    if (!payload) return { ok: true };
    let parsed: unknown = {};
    try {
      parsed = JSON.parse(payload);
    } catch {
      /* ignore */
    }
    await this.queue.get('webhook.inbound').add('slack', { event: parsed }, { removeOnComplete: 5000 });
    return { ok: true };
  }
}
