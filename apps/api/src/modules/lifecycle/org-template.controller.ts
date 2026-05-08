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
import { OrgTemplateService } from './org-template.service.js';
import { RequireRole, RoleGuard } from '../../common/role.guard.js';

@Controller('v1/orgs/:slug/lifecycle-templates')
@UseGuards(RoleGuard)
export class OrgTemplateController {
  constructor(private templates: OrgTemplateService) {}

  @Get()
  async list() {
    return { items: await this.templates.list() };
  }

  @Get(':name')
  async get(@Param('name') name: string) {
    const tpl = await this.templates.get(name);
    if (!tpl && name === 'default') {
      // Auto-bootstrap a default template from the built-in config so the UI has something to show.
      return this.templates.ensureDefault();
    }
    return tpl;
  }

  @Put(':name')
  @RequireRole('admin')
  async upsertYaml(@Param('name') name: string, @Body() body: { yaml: string }) {
    return this.templates.upsertFromYaml(name, body.yaml);
  }

  @Delete(':name')
  @RequireRole('admin')
  async delete(@Param('name') name: string) {
    await this.templates.delete(name);
    return { ok: true };
  }

  // --- Agents ---
  @Put(':name/agents/:ref')
  @RequireRole('admin')
  async upsertAgent(
    @Param('name') name: string,
    @Param('ref') ref: string,
    @Body() body: unknown,
  ) {
    return this.templates.upsertAgent(name, ref, body);
  }

  @Delete(':name/agents/:ref')
  @RequireRole('admin')
  async deleteAgent(@Param('name') name: string, @Param('ref') ref: string) {
    return this.templates.deleteAgent(name, ref);
  }

  // --- Workflows ---
  @Put(':name/workflows/:id')
  @RequireRole('admin')
  async upsertWorkflow(
    @Param('name') name: string,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.templates.upsertWorkflow(name, id, body);
  }

  @Delete(':name/workflows/:id')
  @RequireRole('admin')
  async deleteWorkflow(@Param('name') name: string, @Param('id') id: string) {
    return this.templates.deleteWorkflow(name, id);
  }

  // --- Custom skills ---
  @Put(':name/custom-skills/:skill')
  @RequireRole('admin')
  async upsertCustomSkill(
    @Param('name') name: string,
    @Param('skill') skill: string,
    @Body() body: unknown,
  ) {
    return this.templates.upsertCustomSkill(name, skill, body);
  }

  @Delete(':name/custom-skills/:skill')
  @RequireRole('admin')
  async deleteCustomSkill(
    @Param('name') name: string,
    @Param('skill') skill: string,
  ) {
    return this.templates.deleteCustomSkill(name, skill);
  }

  // --- Human gates ---
  @Put(':name/human-gates')
  @RequireRole('admin')
  async setHumanGates(@Param('name') name: string, @Body() body: unknown) {
    return this.templates.setHumanGates(name, body);
  }
}
