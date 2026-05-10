import { createHmac, randomUUID } from 'node:crypto';
import { withTenant } from '@mergecrew/db';
import type { Logger } from 'pino';

/**
 * One-shot delivery of a single signed webhook POST. Owns retries via
 * BullMQ — it throws on non-2xx so the queue's exponential backoff fires,
 * stopping after the configured max attempts.
 *
 * Signature scheme (#142):
 *   X-Mergecrew-Signature: t=<unix>,v1=<hex_hmac>
 *   X-Mergecrew-Event:     <event_type>
 *   X-Mergecrew-Delivery:  <uuid>     (idempotency key for the receiver)
 *
 * Signed input: `${t}.${rawJsonBody}` HMAC-SHA-256 with the per-webhook
 * secret. Receivers should reject `t` outside ±5 minutes of `now` to
 * mitigate replay.
 */
export interface OutboundJob {
  webhookId: string;
  organizationId: string;
  eventType: string;
  body: unknown;
  /** Optional pre-allocated delivery uuid (e.g. set by the API for "test send"). */
  deliveryUuid?: string;
}

export async function deliverOutboundWebhook(
  job: OutboundJob,
  logger: Logger,
  attempt: number,
): Promise<void> {
  const webhook = await withTenant(job.organizationId, (tx) =>
    tx.outboundWebhook.findFirst({
      where: { id: job.webhookId, organizationId: job.organizationId },
    }),
  );
  if (!webhook || !webhook.enabled) {
    logger.info({ webhookId: job.webhookId }, 'webhook missing or disabled, dropping delivery');
    return;
  }

  const deliveryUuid = job.deliveryUuid ?? randomUUID();
  const t = Math.floor(Date.now() / 1000);
  const rawBody = JSON.stringify({
    type: job.eventType,
    occurredAt: new Date().toISOString(),
    data: job.body,
  });
  const signature = createHmac('sha256', webhook.secret)
    .update(`${t}.${rawBody}`)
    .digest('hex');

  let statusCode: number | null = null;
  let errorMessage: string | null = null;

  try {
    const res = await fetch(webhook.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'X-Mergecrew-Signature': `t=${t},v1=${signature}`,
        'X-Mergecrew-Event': job.eventType,
        'X-Mergecrew-Delivery': deliveryUuid,
        'user-agent': 'Mergecrew-Webhook/1.0',
      },
      body: rawBody,
      signal: AbortSignal.timeout(10_000),
    });
    statusCode = res.status;
    if (!res.ok) {
      errorMessage = `non-2xx: ${res.status}`;
    }
  } catch (err) {
    errorMessage = err instanceof Error ? err.message : String(err);
  }

  await withTenant(job.organizationId, (tx) =>
    tx.webhookDelivery.create({
      data: {
        webhookId: webhook.id,
        deliveryUuid,
        eventType: job.eventType,
        statusCode,
        attempt,
        errorMessage,
      },
    }),
  );

  if (errorMessage) {
    await withTenant(job.organizationId, (tx) =>
      tx.outboundWebhook.update({
        where: { id: webhook.id },
        data: { failureCount: { increment: 1 } },
      }),
    );
    throw new Error(`webhook delivery failed: ${errorMessage}`);
  }

  await withTenant(job.organizationId, (tx) =>
    tx.outboundWebhook.update({
      where: { id: webhook.id },
      data: { lastDeliveredAt: new Date(), failureCount: 0 },
    }),
  );
  logger.info(
    { webhookId: webhook.id, statusCode, attempt },
    'webhook delivered',
  );
}
