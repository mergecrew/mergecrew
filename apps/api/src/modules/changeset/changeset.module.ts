import { Module } from '@nestjs/common';
import { ChangesetController } from './changeset.controller.js';
import { ChangesetService } from './changeset.service.js';

@Module({
  controllers: [ChangesetController],
  providers: [ChangesetService],
  exports: [ChangesetService],
})
export class ChangesetModule {}
