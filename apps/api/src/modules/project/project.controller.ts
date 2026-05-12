import { Body, Controller, Delete, Get, Param, Patch, Post, Put, UseGuards } from '@nestjs/common';
import { ProjectService } from './project.service.js';
import { InceptionService } from './inception.service.js';
import { SmokeTestService } from './smoke-test.service.js';
import { RequireRole, RoleGuard } from '../../common/role.guard.js';

@Controller('v1/orgs/:slug/projects')
@UseGuards(RoleGuard)
export class ProjectController {
  constructor(
    private projects: ProjectService,
    private inception: InceptionService,
    private smokeTest: SmokeTestService,
  ) {}

  @Get()
  async list() {
    return { items: await this.projects.list() };
  }

  @Post()
  @RequireRole('operator')
  async create(@Body() body: { name: string; slug: string }) {
    return this.projects.create(body);
  }

  @Get(':projectSlug')
  async detail(@Param('projectSlug') projectSlug: string) {
    return this.projects.detail(projectSlug);
  }

  @Patch(':projectSlug')
  @RequireRole('operator')
  async update(
    @Param('projectSlug') projectSlug: string,
    @Body() body: {
      name?: string;
      description?: string | null;
      archived?: boolean;
      dryRun?: boolean;
      maxFilesChanged?: number;
      maxLinesChanged?: number;
      deniedPaths?: string[];
    },
  ) {
    return this.projects.update(projectSlug, body);
  }

  @Post(':projectSlug/connect-repo')
  @RequireRole('operator')
  async connectRepo(
    @Param('projectSlug') projectSlug: string,
    @Body() body: {
      installationId: string;
      repoId: string;
      repoFullName: string;
      defaultBranch: string;
    },
  ) {
    return this.projects.connectRepo(projectSlug, body);
  }

  @Delete(':projectSlug/connect-repo')
  @RequireRole('operator')
  async disconnectRepo(@Param('projectSlug') projectSlug: string) {
    await this.projects.disconnectRepo(projectSlug);
    return { ok: true };
  }

  /**
   * After a fresh GitHub App install, the BFF needs the list of repos
   * the installation was granted access to so it can render a dropdown
   * instead of asking the user to type owner/repo (#184). This is
   * org-scoped via the existing role guard — operator+ only.
   */
  @Get(':projectSlug/installation-repos/:installationId')
  @RequireRole('operator')
  async installationRepos(
    @Param('installationId') installationId: string,
  ) {
    return { items: await this.projects.listInstallationRepos(installationId) };
  }

  @Get(':projectSlug/deploy-targets')
  async deployTargets(@Param('projectSlug') projectSlug: string) {
    return { items: await this.projects.listDeployTargets(projectSlug) };
  }

  @Post(':projectSlug/deploy-targets')
  @RequireRole('operator')
  async upsertDeployTarget(
    @Param('projectSlug') projectSlug: string,
    @Body() body: { kind: 'dev' | 'staging' | 'prod'; adapterId: string; config: Record<string, unknown> },
  ) {
    return this.projects.upsertDeployTarget(projectSlug, body);
  }

  @Delete(':projectSlug/deploy-targets/:kind')
  @RequireRole('operator')
  async deleteDeployTarget(
    @Param('projectSlug') projectSlug: string,
    @Param('kind') kind: 'dev' | 'staging' | 'prod',
  ) {
    await this.projects.deleteDeployTarget(projectSlug, kind);
    return { ok: true };
  }

  @Get(':projectSlug/secrets')
  async listSecrets(@Param('projectSlug') projectSlug: string) {
    return { items: await this.projects.listSecrets(projectSlug) };
  }

  @Post(':projectSlug/secrets')
  @RequireRole('operator')
  async setSecret(
    @Param('projectSlug') projectSlug: string,
    @Body() body: { name: string; value: string },
  ) {
    await this.projects.setSecret(projectSlug, body.name, body.value);
    return { ok: true };
  }

  @Delete(':projectSlug/secrets/:name')
  @RequireRole('operator')
  async deleteSecret(@Param('projectSlug') projectSlug: string, @Param('name') name: string) {
    await this.projects.deleteSecret(projectSlug, name);
    return { ok: true };
  }

  @Get(':projectSlug/tracker')
  async getTracker(@Param('projectSlug') projectSlug: string) {
    return this.projects.getTracker(projectSlug);
  }

  @Patch(':projectSlug/tracker')
  @RequireRole('operator')
  async upsertTracker(
    @Param('projectSlug') projectSlug: string,
    @Body() body: { adapterId: string; config: Record<string, unknown>; token?: string },
  ) {
    return this.projects.upsertTracker(projectSlug, body);
  }

  @Delete(':projectSlug/tracker')
  @RequireRole('operator')
  async deleteTracker(@Param('projectSlug') projectSlug: string) {
    await this.projects.deleteTracker(projectSlug);
    return { ok: true };
  }

  @Post(':projectSlug/tracker/test')
  async testTracker(@Param('projectSlug') projectSlug: string) {
    return this.projects.testTracker(projectSlug);
  }

  @Get(':projectSlug/error-target')
  async getErrorTarget(@Param('projectSlug') projectSlug: string) {
    return this.projects.getErrorTarget(projectSlug);
  }

  @Patch(':projectSlug/error-target')
  @RequireRole('operator')
  async upsertErrorTarget(
    @Param('projectSlug') projectSlug: string,
    @Body() body: { adapterId: string; config: Record<string, unknown>; token?: string },
  ) {
    return this.projects.upsertErrorTarget(projectSlug, body);
  }

  @Delete(':projectSlug/error-target')
  @RequireRole('operator')
  async deleteErrorTarget(@Param('projectSlug') projectSlug: string) {
    await this.projects.deleteErrorTarget(projectSlug);
    return { ok: true };
  }

  @Get(':projectSlug/schedule')
  async getSchedule(@Param('projectSlug') projectSlug: string) {
    return this.projects.getSchedule(projectSlug);
  }

  @Patch(':projectSlug/schedule')
  @RequireRole('operator')
  async updateSchedule(
    @Param('projectSlug') projectSlug: string,
    @Body() body: { cron?: string; timezone?: string; enabled?: boolean; skipDates?: string[] },
  ) {
    return this.projects.updateSchedule(projectSlug, body);
  }

  @Get(':projectSlug/auto-promote')
  async getAutoPromote(@Param('projectSlug') projectSlug: string) {
    return { rules: await this.projects.getAutoPromoteRules(projectSlug) };
  }

  @Put(':projectSlug/auto-promote')
  @RequireRole('operator')
  async setAutoPromote(
    @Param('projectSlug') projectSlug: string,
    @Body() body: { rules: unknown },
  ) {
    return { rules: await this.projects.setAutoPromoteRules(projectSlug, body?.rules) };
  }

  @Post(':projectSlug/inception')
  @RequireRole('operator')
  async runInception(@Param('projectSlug') projectSlug: string) {
    return this.inception.run(projectSlug);
  }

  @Post(':projectSlug/smoke-test')
  @RequireRole('operator')
  async runSmokeTest(@Param('projectSlug') projectSlug: string) {
    return this.smokeTest.run(projectSlug);
  }
}
