import nodemailer from 'nodemailer';

export interface EmailConfig {
  smtpUrl?: string;
  from: string;
}

export class EmailClient {
  private transporter?: nodemailer.Transporter;

  constructor(private cfg: EmailConfig) {
    if (cfg.smtpUrl) {
      this.transporter = nodemailer.createTransport(cfg.smtpUrl);
    }
  }

  async send(to: string[], subject: string, html: string): Promise<void> {
    if (!this.transporter) {
      // Dev: log to console.
      console.log(`[email][${this.cfg.from} -> ${to.join(',')}] ${subject}`);
      console.log(html);
      return;
    }
    await this.transporter.sendMail({ from: this.cfg.from, to: to.join(','), subject, html });
  }
}
