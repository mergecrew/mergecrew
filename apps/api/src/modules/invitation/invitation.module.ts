import { Module } from '@nestjs/common';
import { InvitationService } from './invitation.service.js';
import { MyInvitationController, OrgInvitationController } from './invitation.controller.js';

@Module({
  controllers: [OrgInvitationController, MyInvitationController],
  providers: [InvitationService],
  exports: [InvitationService],
})
export class InvitationModule {}
