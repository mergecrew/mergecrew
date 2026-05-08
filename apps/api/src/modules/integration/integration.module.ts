import { Module } from '@nestjs/common';
import { GitHubAppController } from './github-app.controller.js';

@Module({
  controllers: [GitHubAppController],
})
export class IntegrationModule {}
