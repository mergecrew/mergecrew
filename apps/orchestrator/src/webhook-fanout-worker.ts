import { withTenant } from '@mergecrew/db';
import type { FanoutPayload } from '@mergecrew/eventlog';
import type { Queue } from 'bullmq';
import type { Logger } from 'pino';
import type { OutboundJob } from './outbound-webhook-worker.js';
import { dispatchAlertForEvent } from './alert-dispatch.js';

const MAX_PAYLOAD_BYTES = 64 * 1024;

/**
 * Eventlog fanout (#148). One job per persisted event. Looks up active
 * webhooks for the org, filters by event-type subscription (empty array
 * = all events), and enqueues a `webhook.outbound` per match. Each
 * outbound job retries on its own backoff curve.
 *
 * The full timeline event row is loaded here (not shipped through the
 * fanout queue) so we can keep the fanout payload small. If the loaded
 * payload exceeds 64KB, we truncate to keep Redis memory bounded — the
 * receiver can refetch from /timeline if they need the full body.
 */
export async function handleFanout(
  job: FanoutPayload,
  outboundQueue: Queue<OutboundJob>,
  logger: Logger,
): Promise<void> {
  const result = await withTenant(job.organizationId, async (tx) => {
    const event = await tx.timelineEvent.findUnique({
      where: { eventId: job.eventId },
    });
    if (!event) return null;
    const webhooks = await tx.outboundWebhook.findMany({
      where: { organizationId: job.organizationId, enabled: true },
    });
    return { event, webhooks };
  });
  if (!result) {
    logger.warn({ eventId: job.eventId }, 'fanout: timeline event vanished');
    return;
  }

  // V2.af alert routing (#749). Best-effort dispatch to Slack /
  // email-user based on the org's configured channels. Independent of
  // the outbound webhook fan-out below — operators may want webhooks
  // off while still receiving Slack pages.
  await dispatchAlertForEvent({
    organizationId: job.organizationId,
    eventType: job.eventType,
    payload: (result.event.payload ?? null) as Record<string, unknown> | null,
    logger,
  }).catch((err) =>
    logger.warn(
      { err: (err as Error)?.message ?? String(err), eventId: job.eventId },
      'alert.dispatch_failed',
    ),
  );

  const matches = result.webhooks.filter((w) => {
    const events = (w.events as string[]) ?? [];
    return events.length === 0 || events.includes(job.eventType);
  });
  if (matches.length === 0) return;

  let body: unknown = result.event.payload;
  let truncated = false;
  const serialized = JSON.stringify(body);
  if (serialized.length > MAX_PAYLOAD_BYTES) {
    body = { _truncated: true, _size: serialized.length };
    truncated = true;
  }

  for (const w of matches) {
    await outboundQueue.add(
      'event',
      {
        webhookId: w.id,
        organizationId: job.organizationId,
        eventType: job.eventType,
        body: { eventId: job.eventId, occurredAt: job.occurredAt, payload: body, truncated },
      },
      {
        attempts: 6,
        backoff: { type: 'exponential', delay: 1_000 },
        removeOnComplete: 1000,
        removeOnFail: 1000,
      },
    );
  }
  logger.info(
    { eventId: job.eventId, type: job.eventType, fanout: matches.length, truncated },
    'fanout dispatched',
  );
}
