import { CanActivate, ExecutionContext, ForbiddenException, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { roleAtLeast, type OrgRole } from '@mergecrew/domain';
import { TenantContextService } from './tenant-context.service.js';
import { PrismaService } from './prisma.service.js';

export const ROLE_KEY = 'requiredRole';
export const RequireRole = (role: OrgRole) => SetMetadata(ROLE_KEY, role);

/**
 * MFA freshness window. Once a user passes a TOTP/recovery challenge, the
 * resulting JWT's `mfa_at` claim is considered fresh for this long; after
 * that admin/owner routes throw `MFA_CHALLENGE_REQUIRED` and the frontend
 * has to re-prompt via `POST /v1/me/mfa/challenge`.
 */
export const MFA_FRESHNESS_MS = 15 * 60 * 1000;

@Injectable()
export class RoleGuard implements CanActivate {
  constructor(
    private reflector: Reflector,
    private tenant: TenantContextService,
    private prisma: PrismaService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const required = this.reflector.getAllAndOverride<OrgRole>(ROLE_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (!required) return true;
    const t = this.tenant.current();
    if (!t) throw new ForbiddenException();
    if (!roleAtLeast(t.role, required)) {
      throw new ForbiddenException(`requires role ${required}`);
    }

    // MFA gate: any admin-or-above route requires a fresh MFA challenge
    // when the user is enrolled. Unenrolled admins/owners get a distinct
    // error code so the frontend can route them to setup instead of
    // prompting for a code that doesn't exist.
    if (roleAtLeast(t.role, 'admin')) {
      const user = await this.prisma.withSystem((tx) =>
        tx.user.findUnique({
          where: { id: t.userId },
          select: { mfaEnrolledAt: true },
        }),
      );
      if (!user) throw new ForbiddenException();

      if (!user.mfaEnrolledAt) {
        throw new ForbiddenException({
          code: 'MFA_REQUIRED_NOT_ENROLLED',
          message: 'MFA enrollment is required for admin and owner roles',
        } as any);
      }

      const challenged = this.tenant.user()?.mfaChallengedAt;
      if (!challenged || Date.now() - challenged.getTime() > MFA_FRESHNESS_MS) {
        throw new ForbiddenException({
          code: 'MFA_CHALLENGE_REQUIRED',
          message: 'MFA challenge required',
        } as any);
      }
    }
    return true;
  }
}
