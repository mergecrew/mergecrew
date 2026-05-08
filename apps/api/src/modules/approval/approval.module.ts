import { Module } from '@nestjs/common';
import { ApprovalController } from './approval.controller.js';
import { ApprovalService } from './approval.service.js';
import { IntentInboxController } from './intent-inbox.controller.js';

@Module({
  controllers: [ApprovalController, IntentInboxController],
  providers: [ApprovalService],
  exports: [ApprovalService],
})
export class ApprovalModule {}
