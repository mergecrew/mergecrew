import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  IsArray,
  IsBoolean,
  IsOptional,
  IsString,
  IsUrl,
  MaxLength,
} from 'class-validator';
import { OutboundWebhookService } from './outbound-webhook.service.js';
import { RequireRole, RoleGuard } from '../../common/role.guard.js';

class CreateWebhookDto {
  @IsUrl({ require_protocol: true, protocols: ['http', 'https'] })
  @MaxLength(2048)
  url!: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  events?: string[];
}

class UpdateWebhookDto {
  @IsOptional()
  @IsUrl({ require_protocol: true, protocols: ['http', 'https'] })
  @MaxLength(2048)
  url?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  events?: string[];

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}

/**
 * Outbound webhook subscriptions (#141). Admin only. The signing secret
 * is returned exactly once on POST — list/update responses never include
 * it, so a lost secret means rotate the row.
 */
@Controller('v1/orgs/:slug/webhooks')
@UseGuards(RoleGuard)
export class OutboundWebhookController {
  constructor(private webhooks: OutboundWebhookService) {}

  @Post()
  @RequireRole('admin')
  async create(@Body() body: CreateWebhookDto) {
    return this.webhooks.create({ url: body.url, events: body.events });
  }

  @Get()
  @RequireRole('admin')
  async list() {
    return { items: await this.webhooks.list() };
  }

  @Patch(':id')
  @RequireRole('admin')
  async update(@Param('id') id: string, @Body() body: UpdateWebhookDto) {
    return this.webhooks.update(id, body);
  }

  @Delete(':id')
  @RequireRole('admin')
  async remove(@Param('id') id: string) {
    await this.webhooks.remove(id);
    return { ok: true };
  }

  @Get(':id/deliveries')
  @RequireRole('admin')
  async deliveries(@Param('id') id: string, @Query('limit') limit?: string) {
    const n = Math.max(1, Math.min(200, Number(limit ?? 50)));
    return { items: await this.webhooks.deliveries(id, n) };
  }

  @Post(':id/test')
  @RequireRole('admin')
  async test(@Param('id') id: string) {
    return this.webhooks.sendTest(id);
  }
}
