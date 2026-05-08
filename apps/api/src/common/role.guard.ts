import { CanActivate, ExecutionContext, ForbiddenException, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { roleAtLeast, type OrgRole } from '@mergecrew/domain';
import { TenantContextService } from './tenant-context.service.js';

export const ROLE_KEY = 'requiredRole';
export const RequireRole = (role: OrgRole) => SetMetadata(ROLE_KEY, role);

@Injectable()
export class RoleGuard implements CanActivate {
  constructor(private reflector: Reflector, private tenant: TenantContextService) {}

  canActivate(ctx: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<OrgRole>(ROLE_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (!required) return true;
    const t = this.tenant.current();
    if (!t) throw new ForbiddenException();
    if (!roleAtLeast(t.role, required)) throw new ForbiddenException(`requires role ${required}`);
    return true;
  }
}
