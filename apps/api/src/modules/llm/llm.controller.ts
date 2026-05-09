import { Body, Controller, Delete, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { LlmService } from './llm.service.js';
import { RequireRole, RoleGuard } from '../../common/role.guard.js';

@Controller('v1/orgs/:slug/llm')
@UseGuards(RoleGuard)
export class LlmController {
  constructor(private llm: LlmService) {}

  @Get('providers')
  async listProviders() {
    return { items: await this.llm.listProviders() };
  }

  @Post('providers')
  @RequireRole('admin')
  async createProvider(
    @Body() body: {
      kind: 'anthropic' | 'openai' | 'bedrock' | 'ollama';
      label: string;
      apiKey?: string;
      endpoint?: string;
      capabilityOverrides?: Record<string, unknown>;
    },
  ) {
    return this.llm.createProvider(body);
  }

  @Patch('providers/:providerId')
  @RequireRole('admin')
  async updateProvider(
    @Param('providerId') providerId: string,
    @Body()
    body: {
      label?: string;
      endpoint?: string | null;
      apiKey?: string | null;
      capabilityOverrides?: Record<string, unknown> | null;
    },
  ) {
    return this.llm.updateProvider(providerId, body);
  }

  @Delete('providers/:providerId')
  @RequireRole('admin')
  async deleteProvider(@Param('providerId') providerId: string) {
    await this.llm.deleteProvider(providerId);
    return { ok: true };
  }

  @Post('providers/:providerId/test')
  @RequireRole('admin')
  async testProvider(
    @Param('providerId') providerId: string,
    @Body() body: { modelId?: string } = {},
  ) {
    return this.llm.testProvider(providerId, { modelId: body.modelId });
  }

  @Post('providers/:providerId/probe')
  @RequireRole('admin')
  async probeProvider(@Param('providerId') providerId: string) {
    return this.llm.probeProvider(providerId);
  }

  @Get('profiles')
  async listProfiles() {
    return { items: await this.llm.listProfiles() };
  }

  @Post('profiles')
  @RequireRole('admin')
  async createProfile(
    @Body() body: { name: string; preferenceOrder: string[]; capabilityRouting: Record<string, unknown> },
  ) {
    return this.llm.createProfile(body);
  }

  @Patch('profiles/:profileId')
  @RequireRole('admin')
  async updateProfile(
    @Param('profileId') profileId: string,
    @Body() body: {
      name?: string;
      preferenceOrder?: string[];
      capabilityRouting?: Record<string, unknown>;
    },
  ) {
    return this.llm.updateProfile(profileId, body);
  }

  @Delete('profiles/:profileId')
  @RequireRole('admin')
  async deleteProfile(@Param('profileId') profileId: string) {
    await this.llm.deleteProfile(profileId);
    return { ok: true };
  }
}
