import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ChangesetService } from './changeset.service.js';
import { ChangesetCommentService } from './changeset-comment.service.js';
import { RequireRole, RoleGuard } from '../../common/role.guard.js';
import type { DecisionKind } from '@mergecrew/domain';

@Controller('v1/orgs/:slug/projects/:projectSlug')
@UseGuards(RoleGuard)
export class ChangesetController {
  constructor(private cs: ChangesetService, private comments: ChangesetCommentService) {}

  @Get('changesets')
  async list(
    @Param('projectSlug') projectSlug: string,
    @Query('status') status?: string,
    @Query('run_id') runId?: string,
  ) {
    return { items: await this.cs.list(projectSlug, { status, runId }) };
  }

  @Get('changesets/:csId')
  async get(@Param('csId') csId: string) {
    return this.cs.get(csId);
  }

  @Get('changesets/:csId/diff')
  async diff(@Param('csId') csId: string) {
    return this.cs.getDiff(csId);
  }

  @Post('changesets/:csId/decisions')
  @RequireRole('operator')
  async decide(@Param('csId') csId: string, @Body() body: { kind: DecisionKind; comment?: string }) {
    return this.cs.decide(csId, body.kind, body.comment);
  }

  /**
   * One-click rollback (#287). Opens a `git revert` PR for a merged
   * changeset via the project's VCS adapter and stamps the revert PR
   * number + URL onto the changeset. Admin-only — we don't want
   * operator-tier accidentally undoing each other's merges.
   */
  @Post('changesets/:csId/rollback')
  @RequireRole('admin')
  async rollback(@Param('csId') csId: string) {
    return this.cs.rollback(csId);
  }

  @Get('digest/:date')
  async digest(@Param('projectSlug') projectSlug: string, @Param('date') date: string) {
    return this.cs.digestFor(projectSlug, date);
  }

  @Post('digest/:date/group-promote')
  @RequireRole('operator')
  async groupPromote(
    @Param('projectSlug') projectSlug: string,
    @Param('date') date: string,
    @Body() body: { ids: string[] },
  ) {
    return this.cs.groupPromote(projectSlug, date, body.ids);
  }

  @Get('changesets/:csId/comments')
  async listComments(@Param('csId') csId: string) {
    return { items: await this.comments.list(csId) };
  }

  @Post('changesets/:csId/comments')
  async createComment(
    @Param('csId') csId: string,
    @Body() body: {
      filePath: string;
      lineRange?: { startLine: number; endLine: number };
      body: string;
      parentId?: string;
    },
  ) {
    return this.comments.create(csId, body);
  }

  @Patch('changesets/:csId/comments/:commentId')
  async updateComment(
    @Param('commentId') commentId: string,
    @Body() body: { body?: string; resolved?: boolean },
  ) {
    return this.comments.update(commentId, body);
  }

  @Delete('changesets/:csId/comments/:commentId')
  async deleteComment(@Param('commentId') commentId: string) {
    await this.comments.delete(commentId);
    return { ok: true };
  }
}
