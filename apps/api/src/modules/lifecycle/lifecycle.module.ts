import { Module } from '@nestjs/common';
import { LifecycleController } from './lifecycle.controller.js';
import { LifecycleService } from './lifecycle.service.js';
import { LifecyclePrService } from './lifecycle-pr.service.js';
import { OrgTemplateController } from './org-template.controller.js';
import { OrgTemplateService } from './org-template.service.js';
import { SkillsController } from './skills.controller.js';
import { StockTemplateController } from './stock-templates.controller.js';

@Module({
  controllers: [
    LifecycleController,
    SkillsController,
    OrgTemplateController,
    StockTemplateController,
  ],
  providers: [LifecycleService, LifecyclePrService, OrgTemplateService],
  exports: [LifecycleService, LifecyclePrService, OrgTemplateService],
})
export class LifecycleModule {}
