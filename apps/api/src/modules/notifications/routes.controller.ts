import { Body, Controller, Get, Param, Put, UseGuards } from '@nestjs/common';
import {
  ALERT_CHANNELS,
  ALERT_EVENT_KINDS,
  listOrgAlertRoutes,
  type AlertChannel,
  type AlertEventKind,
} from '@mergecrew/db';
import { ValidationError } from '@mergecrew/domain';
import { PrismaService } from '../../common/prisma.service.js';
import { TenantContextService } from '../../common/tenant-context.service.js';
import { RoleGuard, RequireRole } from '../../common/role.guard.js';

@Controller('v1/orgs/:slug/notifications/routes')
@UseGuards(RoleGuard)
export class AlertRoutesController {
  constructor(
    private prisma: PrismaService,
    private tenant: TenantContextService,
  ) {}

  @Get()
  async list(): Promise<{
    items: Array<{ eventKind: AlertEventKind; channels: AlertChannel[]; isDefault: boolean }>;
  }> {
    const t = this.tenant.require();
    const items = await listOrgAlertRoutes(t.organizationId);
    return { items };
  }

  @Put(':eventKind')
  @RequireRole('admin')
  async upsert(
    @Param('eventKind') eventKindRaw: string,
    @Body() body: { channels: string[] },
  ): Promise<{ eventKind: AlertEventKind; channels: AlertChannel[]; isDefault: boolean }> {
    const t = this.tenant.require();
    if (!(ALERT_EVENT_KINDS as readonly string[]).includes(eventKindRaw)) {
      throw new ValidationError(
        `eventKind must be one of ${ALERT_EVENT_KINDS.join(', ')}`,
      );
    }
    if (!Array.isArray(body.channels)) {
      throw new ValidationError('channels must be an array');
    }
    const channels = body.channels.filter((c): c is AlertChannel =>
      (ALERT_CHANNELS as readonly string[]).includes(c),
    );
    if (channels.length !== body.channels.length) {
      throw new ValidationError(
        `channels must each be one of ${ALERT_CHANNELS.join(', ')}`,
      );
    }
    const eventKind = eventKindRaw as AlertEventKind;
    await this.prisma.withTenant(t.organizationId, async (tx) => {
      await tx.alertRoute.upsert({
        where: {
          organizationId_eventKind: {
            organizationId: t.organizationId,
            eventKind,
          },
        },
        update: { channels },
        create: {
          organizationId: t.organizationId,
          eventKind,
          channels,
        },
      });
      await tx.auditLogEntry.create({
        data: {
          organizationId: t.organizationId,
          actorUserId: t.userId,
          action: 'org.alert_route.updated',
          target: { organizationId: t.organizationId, eventKind },
          metadata: { channels },
        },
      });
    });
    return { eventKind, channels, isDefault: false };
  }
}
