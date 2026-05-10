import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { ValidationError } from '@mergecrew/domain';
import { EmailClient } from '@mergecrew/adapters-comms';
import { PrismaService } from '../../common/prisma.service.js';
import { AuthService } from '../auth/auth.service.js';

const TOKEN_BYTES = 32;
const TOKEN_TTL_MS = 15 * 60 * 1000;
const FROM_DEFAULT = 'noreply@mergecrew.dev';

function hashToken(t: string): string {
  return createHash('sha256').update(t).digest('hex');
}

@Injectable()
export class MagicLinkService {
  private email: EmailClient;

  constructor(
    private prisma: PrismaService,
    private auth: AuthService,
  ) {
    this.email = new EmailClient({
      from: process.env.MERGECREW_EMAIL_FROM ?? FROM_DEFAULT,
      smtpUrl: process.env.SMTP_URL,
    });
  }

  /**
   * Create a one-time verification token for `email`, store its hash, and
   * email a magic link. Always returns success — we don't reveal whether
   * an account exists. Token expires after TOKEN_TTL_MS.
   *
   * `callbackUrl` is the absolute URL to redirect to after verification
   * (the BFF's /api/auth/magic-link route). The token is appended as a
   * query parameter.
   */
  async request(input: { email: string; callbackUrl: string }): Promise<void> {
    const email = input.email.trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      throw new ValidationError('invalid email');
    }
    const token = randomBytes(TOKEN_BYTES).toString('base64url');
    const expires = new Date(Date.now() + TOKEN_TTL_MS);

    await this.prisma.withSystem(async (tx) => {
      // One pending token per identifier; clear any previous so an old
      // outstanding link can't be replayed after a new request.
      await tx.authVerificationToken.deleteMany({ where: { identifier: email } });
      await tx.authVerificationToken.create({
        data: { identifier: email, token: hashToken(token), expires },
      });
    });

    const sep = input.callbackUrl.includes('?') ? '&' : '?';
    const link = `${input.callbackUrl}${sep}token=${encodeURIComponent(token)}&email=${encodeURIComponent(email)}`;
    const subject = 'Your Mergecrew sign-in link';
    const html = renderMagicLinkEmail({ link, ttlMinutes: Math.floor(TOKEN_TTL_MS / 60_000) });
    await this.email.send([email], subject, html);
  }

  /**
   * Verify and consume a token. Returns a Mergecrew session JWT on success
   * along with the issued user's profile so the BFF can stamp it into its
   * session cookie without a follow-up round-trip.
   * Throws ValidationError on missing / expired / mismatched token.
   */
  async verify(input: { email: string; token: string }): Promise<{
    token: string;
    user: { id: string; email: string; name: string | null };
  }> {
    const email = input.email.trim().toLowerCase();
    if (!email || !input.token) throw new ValidationError('missing email or token');
    const expectedHash = hashToken(input.token);

    const row = await this.prisma.withSystem((tx) =>
      tx.authVerificationToken.findFirst({ where: { identifier: email } }),
    );
    if (!row) throw new ValidationError('invalid or expired token');
    if (row.expires.getTime() < Date.now()) {
      // Best-effort cleanup; concurrent verifies are fine since deleteMany is idempotent.
      await this.prisma.withSystem((tx) =>
        tx.authVerificationToken.deleteMany({ where: { identifier: email } }),
      );
      throw new ValidationError('invalid or expired token');
    }
    const a = Buffer.from(row.token, 'utf8');
    const b = Buffer.from(expectedHash, 'utf8');
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new ValidationError('invalid or expired token');
    }

    // Single-use: delete after successful match.
    await this.prisma.withSystem((tx) =>
      tx.authVerificationToken.deleteMany({ where: { identifier: email } }),
    );

    const user = await this.auth.findOrCreateByEmail(email);
    const jwt = this.auth.signSessionJwt(user.id);
    return { token: jwt, user: { id: user.id, email: user.email, name: user.name } };
  }
}

function renderMagicLinkEmail(opts: { link: string; ttlMinutes: number }): string {
  return `<!doctype html>
<html><body style="font-family:system-ui,sans-serif;max-width:520px;margin:32px auto;color:#111">
  <h2 style="margin-bottom:8px">Sign in to Mergecrew</h2>
  <p>Click the link below to finish signing in. The link expires in ${opts.ttlMinutes} minutes and works once.</p>
  <p style="margin:24px 0">
    <a href="${opts.link}" style="background:#111;color:#fff;padding:10px 16px;border-radius:6px;text-decoration:none;display:inline-block">Sign in</a>
  </p>
  <p style="font-size:12px;color:#666">If you didn't request this, ignore this email — no action will be taken.</p>
  <p style="font-size:11px;color:#999;word-break:break-all">${opts.link}</p>
</body></html>`;
}
