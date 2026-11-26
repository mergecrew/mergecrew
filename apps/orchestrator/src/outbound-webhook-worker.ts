import { createHmac, randomUUID } from 'node:crypto';
import { withTenant } from '@mergecrew/db';
import {
  discardBody,
  safeFetch,
  SafeFetchError,
  UnsafeEgressError,
  type EgressOptions,
} from '@mergecrew/net';
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
 *
 * Destination safety: the URL is tenant-supplied, so delivery goes
 * through `@mergecrew/net` `safeFetch` — private, loopback, link-local,
 * CGNAT and metadata destinations are refused (unless the operator set
 * `MERGECREW_ALLOW_PRIVATE_EGRESS=1`), the socket is pinned to the
 * vetted address, and redirects are NOT followed (a 3xx counts as a
 * failed delivery). The delivery log records only the HTTP status from
 * public receivers plus a short generic error code — never upstream
 * bodies or transport error text.
 */
export interface OutboundJob {
  webhookId: string;
  organizationId: string;
  eventType: string;
  body: unknown;
  /** Optional pre-allocated delivery uuid (e.g. set by the API for "test send"). */
  deliveryUuid?: string;
}

/** Generic, user-visible delivery error strings. */
export const DELIVERY_ERRORS = {
  blocked: 'destination not allowed',
  redirect: 'redirect not followed',
  timeout: 'timeout',
  network: 'connection failed',
} as const;

export interface DeliveryDeps {
  /** Egress overrides (tests). Defaults to the env-derived policy. */
  egress?: EgressOptions;
  timeoutMs?: number;
}

/**
 * POST one signed payload. Returns the status code (null when no
 * response was received) and a generic error string (null on 2xx).
 */
export async function postWebhook(
  url: string,
  headers: Record<string, string>,
  rawBody: string,
  deps: DeliveryDeps = {},
): Promise<{ statusCode: number | null; errorMessage: string | null; detail?: string }> {
  try {
    const res = await safeFetch(
      url,
      { method: 'POST', headers, body: rawBody, redirect: 'manual' },
      { ...(deps.egress ?? {}), timeoutMs: deps.timeoutMs ?? 10_000, maxResponseBytes: 64 * 1024 },
    );
    await discardBody(res);
    if (res.status >= 300 && res.status < 400) {
      return { statusCode: res.status, errorMessage: DELIVERY_ERRORS.redirect };
    }
    if (res.status < 200 || res.status >= 300) {
      return { statusCode: res.status, errorMessage: `non-2xx: ${res.status}` };
    }
    return { statusCode: res.status, errorMessage: null };
  } catch (err) {
    if (err instanceof UnsafeEgressError) {
      return { statusCode: null, errorMessage: DELIVERY_ERRORS.blocked, detail: err.reason };
    }
    if (err instanceof SafeFetchError && err.code === 'TIMEOUT') {
      return { statusCode: null, errorMessage: DELIVERY_ERRORS.timeout };
    }
    const detail = err instanceof SafeFetchError ? err.code : 'unknown';
    return { statusCode: null, errorMessage: DELIVERY_ERRORS.network, detail };
  }
}

export async function deliverOutboundWebhook(
  job: OutboundJob,
  logger: Logger,
  attempt: number,
  deps: DeliveryDeps = {},
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

  const { statusCode, errorMessage, detail } = await postWebhook(
    webhook.url,
    {
      'content-type': 'application/json',
      'X-Mergecrew-Signature': `t=${t},v1=${signature}`,
      'X-Mergecrew-Event': job.eventType,
      'X-Mergecrew-Delivery': deliveryUuid,
      'user-agent': 'Mergecrew-Webhook/1.0',
    },
    rawBody,
    deps,
  );
  if (errorMessage && detail) {
    logger.warn({ webhookId: webhook.id, attempt, reason: detail }, 'webhook delivery refused or failed');
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
