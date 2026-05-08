import { withTenant } from '@mergecrew/db';
import type { CommsProvider } from './types.js';
import { SlackClient } from './slack.js';
import { EmailClient } from './email.js';

interface CompositeConfig {
  slack?: ConstructorParameters<typeof SlackClient>[0];
  email: ConstructorParameters<typeof EmailClient>[0];
}

export class CompositeCommsProvider implements CommsProvider {
  private slack?: SlackClient;
  private email: EmailClient;

  constructor(cfg: CompositeConfig) {
    if (cfg.slack) this.slack = new SlackClient(cfg.slack);
    this.email = new EmailClient(cfg.email);
  }

  async postSlack(channel: string, text: string, blocks?: any[]): Promise<void> {
    if (!this.slack) throw new Error('slack not configured');
    await this.slack.post(channel, text, blocks);
  }

  async sendEmail(to: string[], subject: string, html: string): Promise<void> {
    await this.email.send(to, subject, html);
  }

  async sendOrgOwnerEmail(organizationId: string, subject: string, html: string): Promise<void> {
    const owners = await withTenant(organizationId, (tx) =>
      tx.membership.findMany({
        where: { organizationId, role: 'owner' },
        include: { user: true },
      }),
    );
    const recipients = owners.map((m) => m.user.email).filter(Boolean);
    if (recipients.length === 0) return;
    await this.email.send(recipients, subject, html);
  }
}
