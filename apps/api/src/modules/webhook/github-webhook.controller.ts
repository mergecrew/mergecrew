import { Controller, ForbiddenException, Headers, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { GitHubProvider, getGitHubAppCredentials } from '@mergecrew/adapters-vcs';
import { QueueService } from '../../common/queue.service.js';
import { GitHubInstallationService } from '../integration/github-installation.service.js';
import { requireRawBody, requireWebhookSecret, verifyGitHubSignature } from './signature.js';

@Controller('v1/webhooks/github')
export class GitHubWebhookController {
  private _gh: GitHubProvider | null = null;

  constructor(
    private queue: QueueService,
    private installations: GitHubInstallationService,
  ) {}

  private gh(): GitHubProvider {
    if (this._gh) return this._gh;
    const creds = getGitHubAppCredentials();
    if (!creds) {
      throw new ForbiddenException('GitHub App not configured');
    }
    this._gh = new GitHubProvider(creds);
    return this._gh;
  }

  @Post()
  async receive(@Headers() headers: Record<string, string>, @Req() req: Request) {
    const body = requireRawBody((req as any).body);
    const secret = requireWebhookSecret('GITHUB_APP_WEBHOOK_SECRET', 'github');
    if (!verifyGitHubSignature(headers, body, secret)) throw new ForbiddenException('invalid signature');
    const event = this.gh().parseWebhookEvent(headers, body);
    // Keep org ↔ installation bindings in sync with GitHub: an
    // uninstalled or suspended installation must stop being usable.
    if (headers['x-github-event'] === 'installation' && event.kind === 'installation') {
      await this.installations.handleInstallationEvent(event.action, event.installationId);
    }
    await this.queue.get('webhook.inbound').add(
      'github',
      { event },
      { removeOnComplete: 5000, removeOnFail: 1000 },
    );
    return { ok: true };
  }
}
