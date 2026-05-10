import { Module } from '@nestjs/common';
import { ProjectController } from './project.controller.js';
import { ProjectService } from './project.service.js';
import { InceptionService } from './inception.service.js';
import { SmokeTestService } from './smoke-test.service.js';

@Module({
  controllers: [ProjectController],
  providers: [ProjectService, InceptionService, SmokeTestService],
  exports: [ProjectService],
})
export class ProjectModule {}
