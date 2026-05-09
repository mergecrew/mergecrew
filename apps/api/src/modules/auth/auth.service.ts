import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../../common/prisma.service.js';

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
   * Mint a session JWT. When `mfaAt` is supplied, the JWT carries an
   * `mfa_at` claim (Unix seconds) that tenant middleware stamps onto the
   * UserContext. Admin/owner-required routes consult that claim via the
   * RoleGuard's MFA gate (#107).
   */
  signSessionJwt(userId: string, opts?: { mfaAt?: Date }): string {
    const payload: Record<string, unknown> = { sub: userId };
    if (opts?.mfaAt) payload.mfa_at = Math.floor(opts.mfaAt.getTime() / 1000);
    return this.jwt.sign(payload);
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
