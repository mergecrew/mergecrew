import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../../common/prisma.service.js';
import { MFA_PENDING_TOKEN_TTL, MFA_PENDING_TOKEN_TYPE } from '../../common/session-token.js';

export interface LoginUser {
  id: string;
  email: string;
  name: string | null;
  tokenVersion: number;
  mfaEnrolledAt: Date | null;
}

export type LoginResult =
  | { token: string; user: { id: string; email: string; name: string | null } }
  | {
      mfaRequired: true;
      /** Short-lived pre-MFA token, valid only for POST /v1/me/mfa/challenge. */
      mfaToken: string;
      user: { id: string; email: string; name: string | null };
    };

@Injectable()
export class AuthService {
  constructor(private prisma: PrismaService, private jwt: JwtService) {}

  /**
   * Find-or-create user by email. Returns the user. The first organization
   * is auto-created from the email if the user has no membership yet.
   */
  async findOrCreateByEmail(email: string, name?: string, avatarUrl?: string) {
    const existing = await this.prisma.withSystem((tx) =>
      tx.user.findUnique({ where: { email } }),
    );
    if (existing) return existing;
    return this.prisma.withSystem((tx) =>
      tx.user.create({
        data: { email, name: name ?? null, avatarUrl: avatarUrl ?? null },
      }),
    );
  }

  /**
   * Mint a full session JWT. `tokenVersion` is stamped as `tv` so sign-out
   * (which bumps the user's version) revokes it server-side. When `mfaAt`
   * is supplied, the JWT carries an `mfa_at` claim (Unix seconds) that the
   * RoleGuard's MFA freshness gate reads.
   */
  signSessionJwt(userId: string, opts: { tokenVersion: number; mfaAt?: Date }): string {
    const payload: Record<string, unknown> = { sub: userId, tv: opts.tokenVersion };
    if (opts.mfaAt) payload.mfa_at = Math.floor(opts.mfaAt.getTime() / 1000);
    return this.jwt.sign(payload);
  }

  /** Short-lived token proving the first factor only (see session-token.ts). */
  signMfaPendingJwt(userId: string, opts: { tokenVersion: number }): string {
    return this.jwt.sign(
      { sub: userId, tv: opts.tokenVersion, typ: MFA_PENDING_TOKEN_TYPE },
      { expiresIn: MFA_PENDING_TOKEN_TTL },
    );
  }

  /**
   * Turn a first-factor login (magic link, OAuth via the BFF) into either a
   * full session or, for MFA-enrolled users, a pre-MFA token that must be
   * exchanged at /v1/me/mfa/challenge.
   */
  issueLogin(user: LoginUser): LoginResult {
    const profile = { id: user.id, email: user.email, name: user.name };
    if (user.mfaEnrolledAt) {
      return {
        mfaRequired: true,
        mfaToken: this.signMfaPendingJwt(user.id, { tokenVersion: user.tokenVersion }),
        user: profile,
      };
    }
    return { token: this.signSessionJwt(user.id, { tokenVersion: user.tokenVersion }), user: profile };
  }

  /**
   * Revoke every outstanding session for the user by bumping the token
   * version. Called on sign-out.
   */
  async revokeSessions(userId: string): Promise<void> {
    await this.prisma.withSystem((tx) =>
      tx.user.update({ where: { id: userId }, data: { tokenVersion: { increment: 1 } } }),
    );
  }

  async sessionInfo(userId: string) {
    const memberships = await this.prisma.withSystem((tx) =>
      tx.membership.findMany({
        where: { userId },
        include: { organization: true },
      }),
    );
    const user = await this.prisma.withSystem((tx) => tx.user.findUnique({ where: { id: userId } }));
    return {
      user: user
        ? { id: user.id, email: user.email, name: user.name, avatarUrl: user.avatarUrl }
        : null,
      orgs: memberships
        .filter((m) => m.organization.deletedAt === null)
        .map((m) => ({
          id: m.organization.id,
          slug: m.organization.slug,
          name: m.organization.name,
          role: m.role,
        })),
    };
  }
}
