import { CanActivate, ExecutionContext, ForbiddenException, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { roleAtLeast, type OrgRole } from '@mergecrew/domain';
import { TenantContextService } from './tenant-context.service.js';

export const ROLE_KEY = 'requiredRole';
export const RequireRole = (role: OrgRole) => SetMetadata(ROLE_KEY, role);

/**
 * Role-based authorization gate.
 *
 * MFA is **recommended** for admin/owner accounts but not enforced — the
 * BFF surfaces a passive nudge when an admin-or-above user hasn't
 * enrolled. Hard-blocking the API path made local development impossible
 * (a fresh checkout couldn't even create an org without standing up an
 * authenticator app + scanning a QR), and that friction outweighs the
 * marginal protection on a self-hostable OSS tool. If you need
 * MFA-required policy on a managed deployment, treat it as a deploy-time
 * config layer (e.g. an enforce-mfa middleware turned on by env), not a
 * code-level guard that ships in the OSS path.
 */
@Injectable()
export class RoleGuard implements CanActivate {
  constructor(
    private reflector: Reflector,
    private tenant: TenantContextService,
  ) {}

  canActivate(ctx: ExecutionContext): boolean {
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
    return true;
  }
}
