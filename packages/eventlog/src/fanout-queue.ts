import type { Queue } from 'bullmq';
import type { EventFanoutHook } from './eventlog.js';

/**
 * Build an `EventFanoutHook` that pushes a small dispatch job onto a
 * BullMQ queue (`webhook.fanout`). The orchestrator consumes the queue,
 * looks up matching webhooks, and enqueues per-webhook deliveries.
 *
 * We don't ship the full event payload onto the queue — just enough for
 * the worker to refetch from `timeline_events`. Avoids bloating Redis
 * memory when payloads are large (e.g. agent step transcripts).
 */
export interface FanoutPayload {
  organizationId: string;
  projectId: string;
  eventId: string;
  eventType: string;
  occurredAt: string;
}

export function fanoutToBullmq(queue: Queue): EventFanoutHook {
  return async (event) => {
    const payload: FanoutPayload = {
      organizationId: event.organizationId,
      projectId: event.projectId,
      eventId: event.id,
      eventType: event.type,
      occurredAt: event.occurredAt,
    };
    await queue.add('event', payload, {
      removeOnComplete: 1000,
      removeOnFail: 1000,
    });
  };
}
