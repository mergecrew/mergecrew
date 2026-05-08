import { Module } from '@nestjs/common';
import { LifecycleController } from './lifecycle.controller.js';
import { LifecycleService } from './lifecycle.service.js';
import { OrgTemplateController } from './org-template.controller.js';
import { OrgTemplateService } from './org-template.service.js';
import { SkillsController } from './skills.controller.js';

@Module({
  controllers: [LifecycleController, SkillsController, OrgTemplateController],
  providers: [LifecycleService, OrgTemplateService],
  exports: [LifecycleService, OrgTemplateService],
})
export class LifecycleModule {}
