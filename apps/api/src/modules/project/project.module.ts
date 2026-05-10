import { Module } from '@nestjs/common';
import { ProjectController } from './project.controller.js';
import { ProjectService } from './project.service.js';
import { InceptionService } from './inception.service.js';

@Module({
  controllers: [ProjectController],
  providers: [ProjectService, InceptionService],
  exports: [ProjectService],
})
export class ProjectModule {}
