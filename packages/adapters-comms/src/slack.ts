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
}
