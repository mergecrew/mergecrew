import { Controller, ForbiddenException, Headers, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import crypto from 'node:crypto';
import { QueueService } from '../../common/queue.service.js';

const FIVE_MINUTES_MS = 5 * 60 * 1000;

@Controller('v1/webhooks/slack/interactivity')
export class SlackWebhookController {
  constructor(private queue: QueueService) {}

  @Post()
  async receive(@Headers() headers: Record<string, string>, @Req() req: Request) {
    const body = (req as any).body as Buffer;
    if (!Buffer.isBuffer(body)) throw new ForbiddenException('expected raw body');

    const secret = process.env.SLACK_SIGNING_SECRET;
    if (!secret) throw new ForbiddenException('slack signing secret not configured');

    const ts = headers['x-slack-request-timestamp'];
    const sig = headers['x-slack-signature'];
    if (!ts || !sig) throw new ForbiddenException('missing slack signature headers');
    if (Math.abs(Date.now() - Number(ts) * 1000) > FIVE_MINUTES_MS) {
      throw new ForbiddenException('slack timestamp too old');
    }
    const base = `v0:${ts}:${body.toString('utf8')}`;
    const expected = `v0=${crypto.createHmac('sha256', secret).update(base).digest('hex')}`;
    const a = Buffer.from(expected);
    const b = Buffer.from(sig);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
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
