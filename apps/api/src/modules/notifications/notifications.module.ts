import { Module } from '@nestjs/common';
import { SlackNotificationsController } from './slack.controller.js';

@Module({ controllers: [SlackNotificationsController] })
export class NotificationsModule {}
