import { Module } from '@nestjs/common';
import { SlackNotificationsController } from './slack.controller.js';
import {
  MeNotificationsController,
  UnsubscribeController,
} from './me.controller.js';
import { AlertRoutesController } from './routes.controller.js';

@Module({
  controllers: [
    SlackNotificationsController,
    MeNotificationsController,
    UnsubscribeController,
    AlertRoutesController,
  ],
})
export class NotificationsModule {}
