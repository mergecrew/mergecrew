import { Body, Controller, Delete, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { ProjectService } from './project.service.js';
import { RequireRole, RoleGuard } from '../../common/role.guard.js';

@Controller('v1/orgs/:slug/projects')
@UseGuards(RoleGuard)
export class ProjectController {
  constructor(private projects: ProjectService) {}

  @Get()
  async list() {
    return { items: await this.projects.list() };
  }

  @Post()
  @RequireRole('admin')
  async create(@Body() body: { name: string; slug: string }) {
    return this.projects.create(body);
  }

  @Get(':projectSlug')
  async detail(@Param('projectSlug') projectSlug: string) {
    return this.projects.detail(projectSlug);
  }

  @Patch(':projectSlug')
  @RequireRole('admin')
  async update(
    @Param('projectSlug') projectSlug: string,
    @Body() body: { name?: string; description?: string | null; archived?: boolean },
  ) {
    return this.projects.update(projectSlug, body);
  }

  @Post(':projectSlug/connect-repo')
  @RequireRole('admin')
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
  @RequireRole('admin')
  async disconnectRepo(@Param('projectSlug') projectSlug: string) {
    await this.projects.disconnectRepo(projectSlug);
    return { ok: true };
  }

  @Get(':projectSlug/deploy-targets')
  async deployTargets(@Param('projectSlug') projectSlug: string) {
    return { items: await this.projects.listDeployTargets(projectSlug) };
  }

  @Post(':projectSlug/deploy-targets')
  @RequireRole('admin')
  async upsertDeployTarget(
    @Param('projectSlug') projectSlug: string,
    @Body() body: { kind: 'dev' | 'staging' | 'prod'; adapterId: string; config: Record<string, unknown> },
  ) {
    return this.projects.upsertDeployTarget(projectSlug, body);
  }

  @Get(':projectSlug/secrets')
  async listSecrets(@Param('projectSlug') projectSlug: string) {
    return { items: await this.projects.listSecrets(projectSlug) };
  }

  @Post(':projectSlug/secrets')
  @RequireRole('admin')
  async setSecret(
    @Param('projectSlug') projectSlug: string,
    @Body() body: { name: string; value: string },
  ) {
    await this.projects.setSecret(projectSlug, body.name, body.value);
    return { ok: true };
  }

  @Delete(':projectSlug/secrets/:name')
  @RequireRole('admin')
  async deleteSecret(@Param('projectSlug') projectSlug: string, @Param('name') name: string) {
    await this.projects.deleteSecret(projectSlug, name);
    return { ok: true };
  }

  @Get(':projectSlug/tracker')
  async getTracker(@Param('projectSlug') projectSlug: string) {
    return this.projects.getTracker(projectSlug);
  }

  @Patch(':projectSlug/tracker')
  @RequireRole('admin')
  async upsertTracker(
    @Param('projectSlug') projectSlug: string,
    @Body() body: { adapterId: string; config: Record<string, unknown>; token?: string },
  ) {
    return this.projects.upsertTracker(projectSlug, body);
  }

  @Delete(':projectSlug/tracker')
  @RequireRole('admin')
  async deleteTracker(@Param('projectSlug') projectSlug: string) {
    await this.projects.deleteTracker(projectSlug);
    return { ok: true };
  }

  @Post(':projectSlug/tracker/test')
  async testTracker(@Param('projectSlug') projectSlug: string) {
    return this.projects.testTracker(projectSlug);
  }
}
