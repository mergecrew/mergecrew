import { Controller, ForbiddenException, Headers, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { GitHubProvider } from '@mergecrew/adapters-vcs';
import { QueueService } from '../../common/queue.service.js';

@Controller('v1/webhooks/github')
export class GitHubWebhookController {
  private _gh: GitHubProvider | null = null;

  constructor(private queue: QueueService) {}

  private gh(): GitHubProvider {
    if (this._gh) return this._gh;
    if (!process.env.GITHUB_APP_ID || !process.env.GITHUB_APP_PRIVATE_KEY) {
      throw new ForbiddenException('GitHub App not configured');
    }
    this._gh = new GitHubProvider({
      appId: process.env.GITHUB_APP_ID,
      privateKey: process.env.GITHUB_APP_PRIVATE_KEY,
    });
    return this._gh;
  }

  @Post()
  async receive(@Headers() headers: Record<string, string>, @Req() req: Request) {
    const body: Buffer = (req as any).body;
    if (!Buffer.isBuffer(body)) throw new ForbiddenException('expected raw body');
    const secret = process.env.GITHUB_APP_WEBHOOK_SECRET ?? '';
    const gh = this.gh();
    const ok = await gh.verifyWebhookSignature(headers, body, secret);
    if (!ok) throw new ForbiddenException('invalid signature');
    const event = gh.parseWebhookEvent(headers, body);
    await this.queue.get('webhook.inbound').add(
      'github',
      { event },
      { removeOnComplete: 5000, removeOnFail: 1000 },
    );
    return { ok: true };
  }
}
