import { Module } from '@nestjs/common';
import { OrgController } from './org.controller.js';
import { OrgService } from './org.service.js';
import { RunnerProfileController } from './runner-profile.controller.js';
import { RunnerProfileService } from './runner-profile.service.js';

@Module({
  controllers: [OrgController, RunnerProfileController],
  providers: [OrgService, RunnerProfileService],
  exports: [OrgService, RunnerProfileService],
})
export class OrgModule {}
