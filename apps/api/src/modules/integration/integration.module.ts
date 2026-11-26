import { Module } from '@nestjs/common';
import { GitHubAppController, GitHubInstallationController } from './github-app.controller.js';
import { GitHubInstallationService } from './github-installation.service.js';

@Module({
  controllers: [GitHubAppController, GitHubInstallationController],
  providers: [GitHubInstallationService],
  exports: [GitHubInstallationService],
})
export class IntegrationModule {}
