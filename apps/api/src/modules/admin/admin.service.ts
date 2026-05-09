import { Injectable } from '@nestjs/common';
import { Queue } from 'bullmq';
import { PrismaService } from '../../common/prisma.service.js';
import { QueueService } from '../../common/queue.service.js';

const PING_TIMEOUT_MS = 200;

const KNOWN_QUEUES = [
  // API-enqueue side
  'run.due',
  'orchestrator.dispatch',
  'runner.step',
  'orchestrator.gate.resume',
  'orchestrator.rate-limit.resume',
  'webhook.inbound',
  // Orchestrator-side fan-out
  'orchestrator.step-reply',
  'digest.dispatch',
  'digest.slack',
  'digest.email',
] as const;

interface PingResult {
  ok: boolean;
  latencyMs: number;
  error?: string;
}

interface QueueCounts {
  waiting: number;
  active: number;
  delayed: number;
  failed: number;
  completed?: number;
}

interface HealthResponse {
  ok: boolean;
  db: PingResult;
  redis: PingResult;
  queues: Record<string, QueueCounts | { error: string }>;
  eventlog: { backlogPg: number };
  version: { sha: string | null; builtAt: string | null };
}

async function timed<T>(fn: () => Promise<T>): Promise<{ ok: true; latencyMs: number; value: T } | { ok: false; latencyMs: number; error: string }> {
  const start = Date.now();
  try {
    const value = await Promise.race([
      fn(),
      new Promise<never>((_r, reject) =>
        setTimeout(() => reject(new Error(`timeout after ${PING_TIMEOUT_MS}ms`)), PING_TIMEOUT_MS),
      ),
    ]);
    return { ok: true, latencyMs: Date.now() - start, value };
  } catch (err) {
    return { ok: false, latencyMs: Date.now() - start, error: (err as Error)?.message ?? String(err) };
  }
}

@Injectable()
export class AdminService {
  private queues: Map<string, Queue> | null = null;

  constructor(
    private prisma: PrismaService,
    private queueSvc: QueueService,
  ) {}

  /**
   * System-wide health snapshot. Authorization is handled by the controller
   * via the existing RoleGuard (`@RequireRole('admin')`) on an org-scoped
   * route — any admin/owner of any org can see the global health.
   */
  async health(): Promise<HealthResponse> {
    const [dbPing, redisPing] = await Promise.all([
      timed(() => this.prisma.withSystem((tx) => tx.$queryRawUnsafe('select 1'))),
      timed(async () => {
        const r = await this.queueSvc.connectionHandle().ping();
        return r;
      }),
    ]);

    const queues = await this.collectQueueCounts();
    const backlogPg = await this.eventlogBacklog();

    const ok = dbPing.ok && redisPing.ok && Object.values(queues).every(
      (v) => 'waiting' in v,
    );

    return {
      ok,
      db: dbPing.ok
        ? { ok: true, latencyMs: dbPing.latencyMs }
        : { ok: false, latencyMs: dbPing.latencyMs, error: dbPing.error },
      redis: redisPing.ok
        ? { ok: true, latencyMs: redisPing.latencyMs }
        : { ok: false, latencyMs: redisPing.latencyMs, error: redisPing.error },
      queues,
      eventlog: { backlogPg },
      version: {
        sha: process.env.GIT_SHA ?? null,
        builtAt: process.env.BUILD_TIMESTAMP ?? null,
      },
    };
  }

  /**
   * One BullMQ Queue per known channel, lazily constructed and reused. Each
   * `getJobCounts` is wrapped in the same 200ms budget — a slow Redis on
   * one channel can't block the whole health response.
   */
  private async collectQueueCounts(): Promise<HealthResponse['queues']> {
    if (!this.queues) {
      this.queues = new Map();
      const conn = this.queueSvc.connectionHandle();
      for (const name of KNOWN_QUEUES) {
        this.queues.set(name, new Queue(name, { connection: conn }));
      }
    }
    const out: HealthResponse['queues'] = {};
    await Promise.all(
      Array.from(this.queues.entries()).map(async ([name, q]) => {
        const r = await timed(() => q.getJobCounts('waiting', 'active', 'delayed', 'failed'));
        if (r.ok) {
          out[name] = {
            waiting: r.value.waiting ?? 0,
            active: r.value.active ?? 0,
            delayed: r.value.delayed ?? 0,
            failed: r.value.failed ?? 0,
          };
        } else {
          out[name] = { error: r.error };
        }
      }),
    );
    return out;
  }

  private async eventlogBacklog(): Promise<number> {
    // Approximate: count timeline_events that haven't yet been streamed to a
    // pubsub subscriber. We don't track that explicitly so this returns 0 in
    // V1 — placeholder for a future pubsub-side cursor. Cheap to ship now so
    // the response shape is stable.
    return 0;
  }
}
