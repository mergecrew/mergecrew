import { Module } from '@nestjs/common';
import { ActivityController } from './activity.controller.js';

@Module({
  controllers: [ActivityController],
})
export class TimelineModule {}
