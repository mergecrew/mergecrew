import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import { LifecycleService } from './lifecycle.service.js';
import { LifecyclePrService } from './lifecycle-pr.service.js';
import type { GraphEdit } from '@mergecrew/config-yaml';
import { RequireRole, RoleGuard } from '../../common/role.guard.js';

@Controller('v1/orgs/:slug/projects/:projectSlug/lifecycle')
@UseGuards(RoleGuard)
export class LifecycleController {
  constructor(
    private lifecycle: LifecycleService,
    private lifecyclePr: LifecyclePrService,
  ) {}

  @Get()
  async current(@Param('projectSlug') projectSlug: string) {
    return this.lifecycle.current(projectSlug);
  }

  @Get('versions')
  async versions(@Param('projectSlug') projectSlug: string) {
    return { items: await this.lifecycle.versions(projectSlug) };
  }

  @Put()
  @RequireRole('admin')
  async upsert(@Param('projectSlug') projectSlug: string, @Body() body: { yaml: string }) {
    return this.lifecycle.upsertFromYaml(projectSlug, body.yaml);
  }

  @Post('apply-template')
  @RequireRole('admin')
  async applyTemplate(
    @Param('projectSlug') projectSlug: string,
    @Body() body: { name?: string },
  ) {
    return this.lifecycle.applyOrgTemplate(projectSlug, body?.name ?? 'default');
  }

  /**
   * Apply a stock lifecycle template by id (#480). Stamps the template
   * id as the new version's name so the audit chain reads cleanly.
   * Centralizes the prior "web fetches template then PUTs the YAML"
   * round-trip in one server-side call.
   */
  @Post('apply-stock-template')
  @RequireRole('admin')
  async applyStockTemplate(
    @Param('projectSlug') projectSlug: string,
    @Body() body: { id: string },
  ) {
    return this.lifecycle.applyStockTemplate(projectSlug, body.id);
  }

  // --- Agents ---
  @Put('agents/:ref')
  @RequireRole('admin')
  async upsertAgent(
    @Param('projectSlug') projectSlug: string,
    @Param('ref') ref: string,
    @Body() body: unknown,
  ) {
    return this.lifecycle.upsertAgent(projectSlug, ref, body);
  }

  @Delete('agents/:ref')
  @RequireRole('admin')
  async deleteAgent(
    @Param('projectSlug') projectSlug: string,
    @Param('ref') ref: string,
  ) {
    return this.lifecycle.deleteAgent(projectSlug, ref);
  }

  // --- Workflows ---
  @Put('workflows/:id')
  @RequireRole('admin')
  async upsertWorkflow(
    @Param('projectSlug') projectSlug: string,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.lifecycle.upsertWorkflow(projectSlug, id, body);
  }

  @Delete('workflows/:id')
  @RequireRole('admin')
  async deleteWorkflow(
    @Param('projectSlug') projectSlug: string,
    @Param('id') id: string,
  ) {
    return this.lifecycle.deleteWorkflow(projectSlug, id);
  }

  // --- Custom skills ---
  @Put('custom-skills/:name')
  @RequireRole('admin')
  async upsertCustomSkill(
    @Param('projectSlug') projectSlug: string,
    @Param('name') name: string,
    @Body() body: unknown,
  ) {
    return this.lifecycle.upsertCustomSkill(projectSlug, name, body);
  }

  @Delete('custom-skills/:name')
  @RequireRole('admin')
  async deleteCustomSkill(
    @Param('projectSlug') projectSlug: string,
    @Param('name') name: string,
  ) {
    return this.lifecycle.deleteCustomSkill(projectSlug, name);
  }

  // --- Human gates ---
  @Put('human-gates')
  @RequireRole('admin')
  async setHumanGates(
    @Param('projectSlug') projectSlug: string,
    @Body() body: unknown,
  ) {
    return this.lifecycle.setHumanGates(projectSlug, body);
  }

  // --- Graph layout (V2.1 phase 2, #195) ---
  @Get('graph-layout')
  async getGraphLayout(@Param('projectSlug') projectSlug: string) {
    return { positions: await this.lifecycle.getGraphLayout(projectSlug) };
  }

  @Put('graph-layout')
  @RequireRole('operator')
  async setGraphLayout(
    @Param('projectSlug') projectSlug: string,
    @Body() body: { positions: Record<string, { x: number; y: number }> },
  ) {
    return this.lifecycle.setGraphLayout(projectSlug, body?.positions ?? {});
  }

  // --- Graph edit PRs (V2.1 phase 3, #196) ---
  @Get('graph-edit-base')
  async graphEditBase(@Param('projectSlug') projectSlug: string) {
    return this.lifecyclePr.currentBaseHash(projectSlug);
  }

  @Post('graph-edit-pr')
  @RequireRole('operator')
  async graphEditPr(
    @Param('slug') orgSlug: string,
    @Param('projectSlug') projectSlug: string,
    @Body() body: { edits: GraphEdit[]; baseHash?: string | null },
  ) {
    return this.lifecyclePr.openLifecycleEditPr(
      orgSlug,
      projectSlug,
      body?.edits ?? [],
      body?.baseHash ?? null,
    );
  }
}
