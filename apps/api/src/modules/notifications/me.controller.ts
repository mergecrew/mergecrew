import { Body, Controller, Get, Patch, Post, Query } from '@nestjs/common';
import crypto from 'node:crypto';
import { ValidationError, NotFoundError } from '@mergecrew/domain';
import { PrismaService } from '../../common/prisma.service.js';
import { TenantContextService } from '../../common/tenant-context.service.js';

const UNSUBSCRIBE_SECRET = () =>
  process.env.JWT_SECRET ?? 'dev-secret';

/**
 * Per-user notification preferences (V2.af / #748). Today: email
 * digest opt-in. Future channels (in-app, mobile, etc.) extend this
 * controller and the matching column set on `users`.
 *
 * The unsubscribe endpoint accepts an HMAC-signed token rather than
 * the user's session cookie, so the footer link in every email works
 * even when the recipient isn't logged in.
 */
@Controller('v1/me')
export class MeNotificationsController {
  constructor(
    private prisma: PrismaService,
    private tenant: TenantContextService,
  ) {}

  @Get('notifications')
  async get(): Promise<{ emailDigestEnabled: boolean }> {
    const u = this.tenant.requireUser();
    const user = await this.prisma.withSystem((tx) =>
      tx.user.findUnique({
        where: { id: u.userId },
        select: { emailDigestEnabled: true },
      }),
    );
    if (!user) throw new NotFoundError();
    return { emailDigestEnabled: user.emailDigestEnabled };
  }

  @Patch('notifications')
  async update(
    @Body() body: { emailDigestEnabled?: boolean },
  ): Promise<{ emailDigestEnabled: boolean }> {
    const u = this.tenant.requireUser();
    if (typeof body.emailDigestEnabled !== 'boolean') {
      throw new ValidationError('emailDigestEnabled must be a boolean');
    }
    const user = await this.prisma.withSystem((tx) =>
      tx.user.update({
        where: { id: u.userId },
        data: { emailDigestEnabled: body.emailDigestEnabled },
        select: { emailDigestEnabled: true },
      }),
    );
    return { emailDigestEnabled: user.emailDigestEnabled };
  }
}

/**
 * Unauthenticated unsubscribe endpoint. The email footer ships
 * `?token=<HMAC>` so a single click flips the opt-in flag without a
 * login round-trip.
 */
@Controller('v1/notifications')
export class UnsubscribeController {
  constructor(private prisma: PrismaService) {}

  @Post('unsubscribe')
  async unsubscribe(
    @Query('token') token: string,
  ): Promise<{ unsubscribed: true; email: string }> {
    if (!token) throw new ValidationError('token is required');
    const payload = verifyUnsubscribeToken(token);
    if (!payload) throw new ValidationError('invalid or expired token');
    const updated = await this.prisma.withSystem((tx) =>
      tx.user.update({
        where: { id: payload.userId },
        data: { emailDigestEnabled: false },
        select: { email: true },
      }),
    );
    return { unsubscribed: true, email: updated.email };
  }
}

/**
 * Mint an unsubscribe token for `userId`. Token format:
 *   `v1.<userId>.<expSeconds>.<hmacHex>`
 * where HMAC is over `v1|userId|expSeconds`. Default validity is
 * 90 days — plenty for emails sitting in a recipient's archive.
 */
export function mintUnsubscribeToken(
  userId: string,
  expiresAt?: Date,
): string {
  const exp = expiresAt
    ? Math.floor(expiresAt.getTime() / 1000)
    : Math.floor(Date.now() / 1000) + 90 * 24 * 60 * 60;
  const base = `v1|${userId}|${exp}`;
  const sig = crypto
    .createHmac('sha256', UNSUBSCRIBE_SECRET())
    .update(base)
    .digest('hex');
  return `v1.${userId}.${exp}.${sig}`;
}

function verifyUnsubscribeToken(
  token: string,
): { userId: string } | null {
  const parts = token.split('.');
  if (parts.length !== 4 || parts[0] !== 'v1') return null;
  const [, userId, expStr, sig] = parts;
  if (!userId || !expStr || !sig) return null;
  const exp = Number(expStr);
  if (!Number.isFinite(exp) || exp < Math.floor(Date.now() / 1000)) return null;
  const base = `v1|${userId}|${exp}`;
  const expected = crypto
    .createHmac('sha256', UNSUBSCRIBE_SECRET())
    .update(base)
    .digest('hex');
  // Constant-time compare. Both buffers are hex-encoded sha256 — same length.
  if (sig.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(expected, 'hex'))) {
    return null;
  }
  return { userId };
}
