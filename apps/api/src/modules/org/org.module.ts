import { Module } from '@nestjs/common';
import { OrgController } from './org.controller.js';
import { OrgService } from './org.service.js';

@Module({
  controllers: [OrgController],
  providers: [OrgService],
  exports: [OrgService],
})
export class OrgModule {}
