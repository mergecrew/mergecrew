import { Controller, Get, NotFoundException, UseGuards } from '@nestjs/common';
import { AdminService } from './admin.service.js';
import { RequireRole, RoleGuard } from '../../common/role.guard.js';
import { TenantContextService } from '../../common/tenant-context.service.js';
import { isTrustedOrgSlug } from '../../common/trusted-orgs.js';

/**
 * Admin endpoints. Mounted under the org-scoped tree so authorization can
 * reuse the existing tenant middleware + RoleGuard. Health is
 * instance-wide, so it is only served to admins of an operator org
 * (MERGECREW_OWNER_ORG_SLUG / MERGECREW_TRUSTED_ORG_SLUGS); for any other
 * org the route does not exist.
 */
@Controller('v1/orgs/:slug/admin')
@UseGuards(RoleGuard)
export class AdminController {
  constructor(
    private admin: AdminService,
    private tenant: TenantContextService,
  ) {}

  @Get('health')
  @RequireRole('admin')
  async health() {
    const t = this.tenant.require();
    if (!isTrustedOrgSlug(t.organizationSlug)) throw new NotFoundException();
    return this.admin.health();
  }
}
