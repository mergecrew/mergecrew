interface SlackConfig {
  /** Bot token (xoxb-…) for chat:write. */
  botToken?: string;
  /** Or per-org incoming webhook URL. */
  webhookUrl?: string;
}

export class SlackClient {
  constructor(private cfg: SlackConfig) {}

  async post(channel: string, text: string, blocks?: any[]): Promise<void> {
    if (this.cfg.botToken) {
      const r = await fetch('https://slack.com/api/chat.postMessage', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.cfg.botToken}`,
          'content-type': 'application/json; charset=utf-8',
        },
        body: JSON.stringify({ channel, text, blocks }),
      });
      const j = (await r.json()) as any;
      if (!j.ok) throw new Error(`slack: ${j.error}`);
      return;
    }
    if (this.cfg.webhookUrl) {
      const r = await fetch(this.cfg.webhookUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text, blocks }),
      });
      if (!r.ok) throw new Error(`slack webhook: ${r.status}`);
      return;
    }
    throw new Error('slack not configured');
  }

  hasBotToken(): boolean {
    return !!this.cfg.botToken;
  }

  /**
   * Resolve a Slack user id from an email. Returns null when the lookup
   * succeeds but the email is unknown (`users_not_found`); throws on any
   * other API error so the caller can decide whether to skip or escalate.
   * Requires `users:read.email` scope.
   */
  async lookupUserByEmail(email: string): Promise<string | null> {
    if (!this.cfg.botToken) throw new Error('slack: bot token required for users.lookupByEmail');
    const url = `https://slack.com/api/users.lookupByEmail?email=${encodeURIComponent(email)}`;
    const r = await fetch(url, {
      headers: { authorization: `Bearer ${this.cfg.botToken}` },
    });
    const j = (await r.json()) as any;
    if (j.ok) return j.user?.id ?? null;
    if (j.error === 'users_not_found') return null;
    throw new Error(`slack: users.lookupByEmail ${j.error}`);
  }

  /** Open (or fetch) a 1:1 DM channel with a user. Requires `im:write` scope. */
  async openDm(userId: string): Promise<string> {
    if (!this.cfg.botToken) throw new Error('slack: bot token required for conversations.open');
    const r = await fetch('https://slack.com/api/conversations.open', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.cfg.botToken}`,
        'content-type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify({ users: userId }),
    });
    const j = (await r.json()) as any;
    if (!j.ok) throw new Error(`slack: conversations.open ${j.error}`);
    return j.channel.id;
  }
}
