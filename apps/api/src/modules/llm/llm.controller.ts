import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
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
}
