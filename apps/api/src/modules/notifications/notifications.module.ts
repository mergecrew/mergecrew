import { Module } from '@nestjs/common';
import { SlackNotificationsController } from './slack.controller.js';
import {
  MeNotificationsController,
  UnsubscribeController,
} from './me.controller.js';

@Module({
  controllers: [
    SlackNotificationsController,
    MeNotificationsController,
    UnsubscribeController,
  ],
})
export class NotificationsModule {}
