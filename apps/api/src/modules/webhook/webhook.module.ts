import { Module } from '@nestjs/common';
import { GitHubWebhookController } from './github-webhook.controller.js';
import { SentryWebhookController } from './sentry-webhook.controller.js';
import { LinearWebhookController } from './linear-webhook.controller.js';
import { SlackWebhookController } from './slack-webhook.controller.js';

@Module({
  controllers: [
    GitHubWebhookController,
    SentryWebhookController,
    LinearWebhookController,
    SlackWebhookController,
  ],
})
export class WebhookModule {}
