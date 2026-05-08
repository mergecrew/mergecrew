import { Module } from '@nestjs/common';
import { RunController } from './run.controller.js';
import { RunService } from './run.service.js';
import { TimelineSseController } from './timeline-sse.controller.js';

@Module({
  controllers: [RunController, TimelineSseController],
  providers: [RunService],
  exports: [RunService],
})
export class RunModule {}
