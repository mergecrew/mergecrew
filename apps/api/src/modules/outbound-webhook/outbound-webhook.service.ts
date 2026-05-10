import { randomBytes, randomUUID } from 'node:crypto';
import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../common/prisma.service.js';
import { QueueService } from '../../common/queue.service.js';
import { TenantContextService } from '../../common/tenant-context.service.js';

export interface IssuedWebhook {
  id: string;
  url: string;
  events: string[];
  enabled: boolean;
  createdAt: Date;
  /** Plaintext secret. Returned ONCE on creation; never again. */
  secret: string;
}

export interface WebhookSummary {
  id: string;
  url: string;
  events: string[];
  enabled: boolean;
  createdAt: Date;
  lastDeliveredAt: Date | null;
  failureCount: number;
}

export interface DeliveryRow {
  id: string;
  deliveryUuid: string;
  eventType: string;
  statusCode: number | null;
  attempt: number;
  occurredAt: Date;
  errorMessage: string | null;
}

@Injectable()
export class OutboundWebhookService {
  constructor(
    private prisma: PrismaService,
    private tenant: TenantContextService,
    private queues: QueueService,
  ) {}

  async create(input: { url: string; events?: string[] }): Promise<IssuedWebhook> {
    const t = this.tenant.require();
    const secret = randomBytes(32).toString('base64url');

    const created = await this.prisma.withTenant(t.organizationId, (tx) =>
      tx.outboundWebhook.create({
        data: {
          organizationId: t.organizationId,
          url: input.url,
          secret,
          events: input.events ?? [],
          createdByUserId: t.userId,
        },
      }),
    );

    await this.prisma.withTenant(t.organizationId, (tx) =>
      tx.auditLogEntry.create({
        data: {
          organizationId: t.organizationId,
          actorUserId: t.userId,
          action: 'webhook.created',
          target: { webhookId: created.id },
          metadata: { url: created.url, events: created.events as any },
        },
      }),
    );

    return {
      id: created.id,
      url: created.url,
      events: created.events as string[],
      enabled: created.enabled,
      createdAt: created.createdAt,
      secret,
    };
  }

  async list(): Promise<WebhookSummary[]> {
    const t = this.tenant.require();
    const rows = await this.prisma.withTenant(t.organizationId, (tx) =>
      tx.outboundWebhook.findMany({
        where: { organizationId: t.organizationId },
        orderBy: { createdAt: 'desc' },
      }),
    );
    return rows.map((r) => ({
      id: r.id,
      url: r.url,
      events: (r.events as string[]) ?? [],
      enabled: r.enabled,
      createdAt: r.createdAt,
      lastDeliveredAt: r.lastDeliveredAt,
      failureCount: r.failureCount,
    }));
  }

  async update(
    id: string,
    input: { url?: string; events?: string[]; enabled?: boolean },
  ): Promise<WebhookSummary> {
    const t = this.tenant.require();
    const found = await this.prisma.withTenant(t.organizationId, (tx) =>
      tx.outboundWebhook.findFirst({ where: { id, organizationId: t.organizationId } }),
    );
    if (!found) throw new NotFoundException();

    const updated = await this.prisma.withTenant(t.organizationId, (tx) =>
      tx.outboundWebhook.update({
        where: { id },
        data: {
          ...(input.url !== undefined ? { url: input.url } : {}),
          ...(input.events !== undefined ? { events: input.events } : {}),
          ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
        },
      }),
    );
    return {
      id: updated.id,
      url: updated.url,
      events: (updated.events as string[]) ?? [],
      enabled: updated.enabled,
      createdAt: updated.createdAt,
      lastDeliveredAt: updated.lastDeliveredAt,
      failureCount: updated.failureCount,
    };
  }

  async remove(id: string): Promise<void> {
    const t = this.tenant.require();
    const found = await this.prisma.withTenant(t.organizationId, (tx) =>
      tx.outboundWebhook.findFirst({ where: { id, organizationId: t.organizationId } }),
    );
    if (!found) throw new NotFoundException();
    await this.prisma.withTenant(t.organizationId, (tx) =>
      tx.outboundWebhook.delete({ where: { id } }),
    );
    await this.prisma.withTenant(t.organizationId, (tx) =>
      tx.auditLogEntry.create({
        data: {
          organizationId: t.organizationId,
          actorUserId: t.userId,
          action: 'webhook.deleted',
          target: { webhookId: id },
          metadata: { url: found.url },
        },
      }),
    );
  }

  async sendTest(id: string): Promise<{ deliveryUuid: string }> {
    const t = this.tenant.require();
    const found = await this.prisma.withTenant(t.organizationId, (tx) =>
      tx.outboundWebhook.findFirst({ where: { id, organizationId: t.organizationId } }),
    );
    if (!found) throw new NotFoundException();
    const deliveryUuid = randomUUID();
    // Backoff: 1s → 4s → 16s → 1m → 5m → 30m, drop after 6 attempts.
    await this.queues.get('webhook.outbound').add(
      'test',
      {
        webhookId: id,
        organizationId: t.organizationId,
        eventType: 'webhook.test',
        body: { message: 'ping from Mergecrew', triggeredBy: t.userId },
        deliveryUuid,
      },
      {
        attempts: 6,
        backoff: { type: 'exponential', delay: 1_000 },
        removeOnComplete: 1000,
        removeOnFail: 1000,
      },
    );
    return { deliveryUuid };
  }

  async deliveries(id: string, limit = 50): Promise<DeliveryRow[]> {
    const t = this.tenant.require();
    const found = await this.prisma.withTenant(t.organizationId, (tx) =>
      tx.outboundWebhook.findFirst({ where: { id, organizationId: t.organizationId } }),
    );
    if (!found) throw new NotFoundException();
    const rows = await this.prisma.withTenant(t.organizationId, (tx) =>
      tx.webhookDelivery.findMany({
        where: { webhookId: id },
        orderBy: { occurredAt: 'desc' },
        take: limit,
      }),
    );
    return rows.map((r) => ({
      id: r.id,
      deliveryUuid: r.deliveryUuid,
      eventType: r.eventType,
      statusCode: r.statusCode,
      attempt: r.attempt,
      occurredAt: r.occurredAt,
      errorMessage: r.errorMessage,
    }));
  }
}
