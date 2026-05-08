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

export class Eventlog {
  constructor(private readonly pubsub: RedisPubSub) {}

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
      const rows = await tx.timelineEvent.findMany({
        where: { dailyRunId, ...(afterEventId ? { eventId: { not: afterEventId } } : {}) },
        orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
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
