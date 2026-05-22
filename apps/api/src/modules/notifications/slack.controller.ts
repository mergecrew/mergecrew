import {
  Body,
  Controller,
  Delete,
  Get,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import { SlackClient } from '@mergecrew/adapters-comms';
import { ValidationError } from '@mergecrew/domain';
import { PrismaService } from '../../common/prisma.service.js';
import { TenantContextService } from '../../common/tenant-context.service.js';
import { CryptoService } from '../../common/crypto.service.js';
import { RoleGuard, RequireRole } from '../../common/role.guard.js';

type SlackStatus = {
  configured: boolean;
  createdAt: string | null;
};

@Controller('v1/orgs/:slug/notifications/slack')
@UseGuards(RoleGuard)
export class SlackNotificationsController {
  constructor(
    private prisma: PrismaService,
    private tenant: TenantContextService,
    private crypto: CryptoService,
  ) {}

  @Get()
  async status(): Promise<SlackStatus> {
    const t = this.tenant.require();
    const org = await this.prisma.withTenant(t.organizationId, (tx) =>
      tx.organization.findFirst({
        where: { id: t.organizationId },
        select: { slackWebhookCiphertext: true, slackWebhookCreatedAt: true },
      }),
    );
    return {
      configured: !!org?.slackWebhookCiphertext,
      createdAt: org?.slackWebhookCreatedAt?.toISOString() ?? null,
    };
  }

  @Put()
  @RequireRole('admin')
  async set(@Body() body: { url: string }): Promise<SlackStatus> {
    const t = this.tenant.require();
    if (typeof body.url !== 'string') {
      throw new ValidationError('url is required');
    }
    const url = body.url.trim();
    if (!isSlackWebhookUrl(url)) {
      throw new ValidationError(
        'url must be an https://hooks.slack.com/services/... incoming webhook',
      );
    }
    const ciphertext = this.crypto.encrypt(url);
    const now = new Date();
    await this.prisma.withTenant(t.organizationId, (tx) =>
      tx.organization.update({
        where: { id: t.organizationId },
        data: {
          slackWebhookCiphertext: ciphertext,
          slackWebhookCreatedAt: now,
        },
      }),
    );
    return { configured: true, createdAt: now.toISOString() };
  }

  @Delete()
  @RequireRole('admin')
  async clear(): Promise<SlackStatus> {
    const t = this.tenant.require();
    await this.prisma.withTenant(t.organizationId, (tx) =>
      tx.organization.update({
        where: { id: t.organizationId },
        data: {
          slackWebhookCiphertext: null,
          slackWebhookCreatedAt: null,
        },
      }),
    );
    return { configured: false, createdAt: null };
  }

  @Post('test')
  @RequireRole('admin')
  async test(): Promise<{ ok: true }> {
    const t = this.tenant.require();
    const org = await this.prisma.withTenant(t.organizationId, (tx) =>
      tx.organization.findFirst({
        where: { id: t.organizationId },
        select: { slackWebhookCiphertext: true, name: true },
      }),
    );
    if (!org?.slackWebhookCiphertext) {
      throw new ValidationError('slack webhook is not configured');
    }
    const url = this.crypto.decrypt(Buffer.from(org.slackWebhookCiphertext));
    const client = new SlackClient({ webhookUrl: url });
    await client.post(
      '',
      `:wave: Test message from mergecrew · ${org.name}. Slack webhook is wired up.`,
    );
    return { ok: true };
  }
}

function isSlackWebhookUrl(url: string): boolean {
  return /^https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/_-]+$/.test(url);
}
