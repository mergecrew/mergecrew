import { Module } from '@nestjs/common';
import { ChangesetController } from './changeset.controller.js';
import { ChangesetService } from './changeset.service.js';
import { ChangesetCommentService } from './changeset-comment.service.js';

@Module({
  controllers: [ChangesetController],
  providers: [ChangesetService, ChangesetCommentService],
  exports: [ChangesetService, ChangesetCommentService],
})
export class ChangesetModule {}
