import { Controller, Get, UseGuards } from '@nestjs/common';
import { AdminService } from './admin.service.js';
import { RequireRole, RoleGuard } from '../../common/role.guard.js';

/**
 * Admin endpoints. Mounted under the org-scoped tree so authorization can
 * reuse the existing tenant middleware + RoleGuard — the slug in the URL
 * doesn't actually scope the response (health is system-wide), it just
 * proves the caller has admin context somewhere.
 */
@Controller('v1/orgs/:slug/admin')
@UseGuards(RoleGuard)
export class AdminController {
  constructor(private admin: AdminService) {}

  @Get('health')
  @RequireRole('admin')
  async health() {
    return this.admin.health();
  }
}
