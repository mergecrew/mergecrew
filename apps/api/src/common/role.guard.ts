import { CanActivate, ExecutionContext, ForbiddenException, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { roleAtLeast, type OrgRole } from '@mergecrew/domain';
import { TenantContextService, type UserContext } from './tenant-context.service.js';

export const ROLE_KEY = 'requiredRole';
export const RequireRole = (role: OrgRole) => SetMetadata(ROLE_KEY, role);

/** How recent the last MFA challenge must be for an admin/owner write. */
export const MFA_FRESHNESS_WINDOW_MS = 15 * 60 * 1000;

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Pure MFA-freshness decision, exported for tests.
 *
 * Applies to write requests on routes that require `admin` or `owner` when
 * the caller is MFA-enrolled and authenticated with a user session. API keys
 * are exempt (the issuing admin passed MFA when minting the key), and users
 * who have not enrolled keep the passive "MFA recommended" nudge instead of
 * a hard block — local development and fresh installs stay usable.
 */
export function mfaFreshnessViolation(opts: {
  required: OrgRole;
  method: string;
  user: UserContext | undefined;
  now?: number;
}): boolean {
  const { required, method, user } = opts;
  if (required !== 'admin' && required !== 'owner') return false;
  if (SAFE_METHODS.has(method.toUpperCase())) return false;
  if (!user || user.apiKeyId) return false;
  if (!user.mfaEnrolled) return false;
  const at = user.mfaChallengedAt?.getTime();
  if (at === undefined || Number.isNaN(at)) return true;
  const now = opts.now ?? Date.now();
  return now - at > MFA_FRESHNESS_WINDOW_MS;
}

/**
 * Role-based authorization gate, plus the MFA freshness gate for
 * admin/owner write actions (see `mfaFreshnessViolation`). A stale or
 * missing challenge returns 403 `MFA_REQUIRED`; the web surfaces this as
 * "re-enter a code" on /account/security.
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
    const method = ctx.switchToHttp().getRequest<{ method?: string }>()?.method ?? 'GET';
    if (mfaFreshnessViolation({ required, method, user: this.tenant.user() })) {
      throw new ForbiddenException({
        code: 'MFA_REQUIRED',
        message:
          'This action requires a recent MFA challenge. Enter a code under Account → Security, then retry.',
      });
    }
    return true;
  }
}
