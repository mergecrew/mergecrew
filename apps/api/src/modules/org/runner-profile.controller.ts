import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { RoleGuard } from '../../common/role.guard.js';
import { RunnerProfileService } from './runner-profile.service.js';

/**
 * Per-org runner profile read endpoint (V2.af / ADR-0002). Write paths
 * land in #767; this PR exposes a read-only view so the web UI can
 * render the current state and operators can audit which org runs
 * where.
 */
@Controller('v1')
export class RunnerProfileController {
  constructor(private readonly runnerProfile: RunnerProfileService) {}

  @Get('orgs/:slug/runner-profile')
  @UseGuards(RoleGuard)
  async get(@Param('slug') _slug: string) {
    return this.runnerProfile.get();
  }
}
