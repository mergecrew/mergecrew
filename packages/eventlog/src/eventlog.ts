import { withTenant, type Prisma } from '@mergecrew/db';
import {
  type TimelineEvent,
  type TimelineEventType,
  type TimelineActor,
} from '@mergecrew/domain';
import { RedisPubSub } from './pubsub.js';

export interface EmitInput {
  organizationId: string;
  projectId: string;
  dailyRunId?: string | null;
  workflowRunId?: string | null;
  agentStepId?: string | null;
  changesetId?: string | null;
  parentEventId?: string | null;
  type: TimelineEventType;
  actor: TimelineActor;
  payload?: Record<string, unknown>;
}

/**
 * Optional fanout sink. When provided, every persisted event triggers one
 * call after the pubsub broadcast — used by services with bullmq to push
 * webhook.fanout jobs onto the orchestrator queue (#148). Best-effort:
 * the hook should swallow its own errors (we don't fail emit() if the
 * fanout enqueue fails).
 */
export type EventFanoutHook = (event: TimelineEvent) => void | Promise<void>;

export class Eventlog {
  constructor(
    private readonly pubsub: RedisPubSub,
    private readonly fanout?: EventFanoutHook,
  ) {}

  /**
   * Persist a timeline event and broadcast it on Redis pubsub. Returns the
   * persisted shape so the caller can return it from an HTTP API.
   */
  async emit(input: EmitInput): Promise<TimelineEvent> {
    const eventId = crypto.randomUUID();
    const occurredAt = new Date();

    const persisted: TimelineEvent = {
      id: eventId,
      organizationId: input.organizationId,
      projectId: input.projectId,
      dailyRunId: input.dailyRunId ?? null,
      workflowRunId: input.workflowRunId ?? null,
      agentStepId: input.agentStepId ?? null,
      changesetId: input.changesetId ?? null,
      parentEventId: input.parentEventId ?? null,
      type: input.type,
      actor: input.actor,
      payload: input.payload ?? {},
      occurredAt: occurredAt.toISOString(),
    };

    await withTenant(input.organizationId, async (tx) => {
      await tx.timelineEvent.create({
        data: {
          eventId,
          organizationId: input.organizationId,
          projectId: input.projectId,
          dailyRunId: input.dailyRunId ?? null,
          workflowRunId: input.workflowRunId ?? null,
          agentStepId: input.agentStepId ?? null,
          changesetId: input.changesetId ?? null,
          parentEventId: input.parentEventId ?? null,
          type: input.type,
          actor: input.actor as Prisma.InputJsonValue,
          payload: (input.payload ?? {}) as Prisma.InputJsonValue,
          occurredAt,
        },
      });
    });

    // Fan out: per-run channel for SSE; per-project channel for org-wide views.
    if (input.dailyRunId) {
      await this.pubsub.publish(`run:${input.dailyRunId}`, persisted);
    }
    await this.pubsub.publish(`project:${input.projectId}`, persisted);

    // Outbound webhook fanout (#148). Best-effort — emit() doesn't fail if
    // enqueue does, since the timeline row is already durable and the
    // webhook system is meant to be a best-effort notification surface.
    if (this.fanout) {
      try {
        await this.fanout(persisted);
      } catch {
        // Swallow; the caller is responsible for its own logging.
      }
    }
    return persisted;
  }

  /**
   * Replay events for a run. Used both for the timeline replay UI and for
   * SSE clients that reconnect with a Last-Event-ID.
   */
  async replayRun(
    organizationId: string,
    dailyRunId: string,
    afterEventId?: string,
  ): Promise<TimelineEvent[]> {
    return withTenant(organizationId, async (tx) => {
      // Resolve the marker's autoincrement id (BIGINT PK) so the where can
      // use a strict `id > marker` range — this is what SSE clients actually
      // mean by "Last-Event-ID". A previous version used `{ eventId: { not:
      // afterEventId } }` which returned the entire run minus the marker.
      let afterPk: bigint | null = null;
      if (afterEventId) {
        const marker = await tx.timelineEvent.findUnique({
          where: { eventId: afterEventId },
          select: { id: true },
        });
        if (marker) afterPk = marker.id;
      }
      const rows = await tx.timelineEvent.findMany({
        where: {
          dailyRunId,
          ...(afterPk !== null ? { id: { gt: afterPk } } : {}),
        },
        orderBy: { id: 'asc' },
        take: 5000,
      });
      return rows.map((r) => ({
        id: r.eventId,
        organizationId: r.organizationId,
        projectId: r.projectId,
        dailyRunId: r.dailyRunId,
        workflowRunId: r.workflowRunId,
        agentStepId: r.agentStepId,
        changesetId: r.changesetId,
        parentEventId: r.parentEventId,
        type: r.type as TimelineEventType,
        actor: r.actor as TimelineActor,
        payload: r.payload as Record<string, unknown>,
        occurredAt: r.occurredAt.toISOString(),
      }));
    });
  }
}
