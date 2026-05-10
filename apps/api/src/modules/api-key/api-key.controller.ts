import { Body, Controller, Delete, Get, Param, Post, UseGuards } from '@nestjs/common';
import { IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { ApiKeyService } from './api-key.service.js';
import { RequireRole, RoleGuard } from '../../common/role.guard.js';

class IssueKeyDto {
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  name!: string;

  @IsOptional()
  @IsString()
  @IsIn(['owner', 'admin', 'operator', 'viewer'])
  role?: 'owner' | 'admin' | 'operator' | 'viewer';
}

/**
 * API key management. Scoped per-org; admin-only. The plaintext token is
 * returned exactly once on POST — list/revoke responses never include it.
 */
@Controller('v1/orgs/:slug/api-keys')
@UseGuards(RoleGuard)
export class ApiKeyController {
  constructor(private apiKeys: ApiKeyService) {}

  @Post()
  @RequireRole('admin')
  async issue(@Body() body: IssueKeyDto) {
    return this.apiKeys.issue({ name: body.name, role: body.role });
  }

  @Get()
  @RequireRole('admin')
  async list() {
    return { items: await this.apiKeys.list() };
  }

  @Delete(':id')
  @RequireRole('admin')
  async revoke(@Param('id') id: string) {
    await this.apiKeys.revoke(id);
    return { ok: true };
  }
}
