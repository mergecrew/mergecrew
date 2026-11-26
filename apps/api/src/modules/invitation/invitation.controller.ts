import { Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { InvitationService } from './invitation.service.js';
import { RequireRole, RoleGuard } from '../../common/role.guard.js';

/** Admin view of an org's pending invitations. Creation is POST /v1/orgs/:slug/members. */
@Controller('v1/orgs/:slug/invitations')
export class OrgInvitationController {
  constructor(private invitations: InvitationService) {}

  @Get()
  @UseGuards(RoleGuard)
  @RequireRole('admin')
  async list(@Param('slug') _slug: string) {
    return this.invitations.listForOrg();
  }

  @Delete(':id')
  @UseGuards(RoleGuard)
  @RequireRole('admin')
  async revoke(@Param('slug') _slug: string, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.invitations.revoke(id);
  }
}

/** Invitee side: invitations addressed to the signed-in user's email. */
@Controller('v1/me/invitations')
export class MyInvitationController {
  constructor(private invitations: InvitationService) {}

  @Get()
  async list() {
    return this.invitations.listMine();
  }

  @Post(':id/accept')
  @HttpCode(200)
  async accept(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.invitations.accept(id);
  }

  @Post(':id/decline')
  @HttpCode(200)
  async decline(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.invitations.decline(id);
  }
}
