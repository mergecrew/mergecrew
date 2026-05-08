import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { ApprovalService } from './approval.service.js';
import { RequireRole, RoleGuard } from '../../common/role.guard.js';
import type { GateDecision } from '@mergecrew/domain';

@Controller('v1/orgs/:slug')
@UseGuards(RoleGuard)
export class ApprovalController {
  constructor(private approvals: ApprovalService) {}

  @Get('inbox')
  async inbox() {
    return { items: await this.approvals.listInbox() };
  }

  @Get('projects/:projectSlug/approvals')
  async listForProject(@Param('projectSlug') projectSlug: string) {
    return { items: await this.approvals.listForProject(projectSlug) };
  }

  @Post('projects/:projectSlug/approvals/:approvalId/resolve')
  @RequireRole('operator')
  async resolve(
    @Param('approvalId') approvalId: string,
    @Body() body: { resolution: GateDecision; comment?: string },
  ) {
    return this.approvals.resolve(approvalId, body.resolution, body.comment);
  }
}
