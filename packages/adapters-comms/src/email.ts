import nodemailer from 'nodemailer';

export type EmailProvider = 'smtp' | 'resend' | 'auto';

export interface EmailConfig {
  from: string;
  smtpUrl?: string;
  /**
   * Resend.com API key (e.g. `re_xxx`). When set, EmailClient sends via
   * Resend's HTTPS API instead of nodemailer/SMTP. Lower-friction option
   * for OSS installs that don't want to operate an SMTP relay.
   */
  resendApiKey?: string;
  /**
   * Override the auto-pick between providers. Defaults to `'auto'`, which
   * prefers Resend when its key is set, falls back to SMTP when its URL
   * is set, otherwise dumps to console for dev. Set explicitly to pin a
   * provider when both are configured.
   */
  provider?: EmailProvider;
}

type EffectiveProvider = 'smtp' | 'resend' | 'console';

const RESEND_API_URL = 'https://api.resend.com/emails';

function resolveProvider(cfg: EmailConfig): EffectiveProvider {
  const explicit = cfg.provider ?? 'auto';
  if (explicit === 'resend') {
    if (!cfg.resendApiKey) {
      // Loud failure beats silent dev-console demotion in prod — the
      // magic-link auth path would otherwise permanently lock users out.
      throw new Error('EmailClient: provider="resend" requires a Resend API key (RESEND_API_KEY)');
    }
    return 'resend';
  }
  if (explicit === 'smtp') {
    if (!cfg.smtpUrl) {
      throw new Error('EmailClient: provider="smtp" requires an SMTP URL (SMTP_URL)');
    }
    return 'smtp';
  }
  // auto
  if (cfg.resendApiKey) return 'resend';
  if (cfg.smtpUrl) return 'smtp';
  return 'console';
}

export class EmailClient {
  private transporter?: nodemailer.Transporter;
  private readonly effective: EffectiveProvider;

  constructor(private cfg: EmailConfig) {
    this.effective = resolveProvider(cfg);
    if (this.effective === 'smtp') {
      this.transporter = nodemailer.createTransport(cfg.smtpUrl!);
    }
  }

  async send(to: string[], subject: string, html: string): Promise<void> {
    if (this.effective === 'console') {
      // Dev: log to console.
      console.log(`[email][${this.cfg.from} -> ${to.join(',')}] ${subject}`);
      console.log(html);
      return;
    }
    if (this.effective === 'resend') {
      await this.sendViaResend(to, subject, html);
      return;
    }
    await this.transporter!.sendMail({ from: this.cfg.from, to: to.join(','), subject, html });
  }

  private async sendViaResend(to: string[], subject: string, html: string): Promise<void> {
    const r = await fetch(RESEND_API_URL, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.cfg.resendApiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ from: this.cfg.from, to, subject, html }),
    });
    if (!r.ok) {
      // Resend returns { name, message, statusCode } on error. Surface
      // the message in the thrown Error so prod log triage stays useful
      // without ever logging the API key or the body.
      let detail = '';
      try {
        const j = (await r.json()) as { message?: string; name?: string };
        detail = j.message ? `: ${j.message}` : j.name ? `: ${j.name}` : '';
      } catch {
        /* body not JSON — swallow */
      }
      throw new Error(`resend ${r.status}${detail}`);
    }
  }
}
