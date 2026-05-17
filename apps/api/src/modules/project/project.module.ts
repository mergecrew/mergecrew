import { Module } from '@nestjs/common';
import { ProjectController } from './project.controller.js';
import { ProjectService } from './project.service.js';
import { InceptionService } from './inception.service.js';
import { SmokeTestService } from './smoke-test.service.js';
import { PromotionStrategyService } from './promotion-strategy.service.js';
import { PromoteService } from './promote.service.js';

@Module({
  controllers: [ProjectController],
  providers: [
    ProjectService,
    InceptionService,
    SmokeTestService,
    PromotionStrategyService,
    PromoteService,
  ],
  exports: [ProjectService, PromotionStrategyService, PromoteService],
})
export class ProjectModule {}
