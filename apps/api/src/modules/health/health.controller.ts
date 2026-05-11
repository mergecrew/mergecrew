import { Controller, Get, HttpStatus, Res } from '@nestjs/common';
import type { Response } from 'express';
import { PrismaService } from '../../common/prisma.service.js';
import { QueueService } from '../../common/queue.service.js';
import { exposition, queueDepthGauge } from './metrics.js';

interface HealthBody {
  status: 'ok' | 'degraded';
  checks: {
    db: 'ok' | 'fail';
    redis: 'ok' | 'fail';
  };
  details?: { db?: string; redis?: string };
}

// Liveness/readiness + Prometheus exposition. Both endpoints are
// unauthenticated by design — they're scraped by infra, not users — and
// sit at the root path (no /v1 prefix) so the existing API tenant
// middleware skips them.
@Controller()
export class HealthController {
  // The health check runs SELECT 1 + redis.ping every request. Both are
  // sub-millisecond on a healthy stack; we don't bother caching the result
  // because liveness probes typically run on a 10s interval anyway.
  constructor(private prisma: PrismaService, private queue: QueueService) {}

  @Get('healthz')
  async healthz(@Res({ passthrough: true }) res: Response): Promise<HealthBody> {
    const body: HealthBody = {
      status: 'ok',
      checks: { db: 'ok', redis: 'ok' },
    };
    const details: { db?: string; redis?: string } = {};

    try {
      await this.prisma.withSystem((tx) => tx.$queryRaw`select 1`);
    } catch (e: any) {
      body.checks.db = 'fail';
      details.db = String(e?.message ?? e);
    }

    try {
      const pong = await this.queue.connectionHandle().ping();
      if (pong !== 'PONG') {
        body.checks.redis = 'fail';
        details.redis = `redis ping returned ${pong}`;
      }
    } catch (e: any) {
      body.checks.redis = 'fail';
      details.redis = String(e?.message ?? e);
    }

    if (body.checks.db === 'fail' || body.checks.redis === 'fail') {
      body.status = 'degraded';
      body.details = details;
      res.status(HttpStatus.SERVICE_UNAVAILABLE);
    }
    return body;
  }

  @Get('metrics')
  async metrics(@Res({ passthrough: true }) res: Response): Promise<string> {
    // Sample queue depths just before exposition. Cheap (Redis llen on a
    // handful of keys) and avoids carrying yet another background tick.
    try {
      await this.refreshQueueDepths();
    } catch {
      // Best-effort; an unreachable Redis would already have failed the
      // healthz check above.
    }
    const { body, contentType } = await exposition();
    res.setHeader('content-type', contentType);
    return body;
  }

  private async refreshQueueDepths(): Promise<void> {
    const redis = this.queue.connectionHandle();
    const queues = [
      'run.due',
      'runner.step',
      'webhook.fanout',
      'webhook.outbound',
      'gate.wait',
      'rate.wait',
      'org-cap.wait',
      'digest',
    ];
    for (const q of queues) {
      // BullMQ key namespace: `bull:<queue>:wait`, `:active`, `:delayed`,
      // `:failed`. `llen` for lists, `zcard` for the delayed sorted-set.
      const [waiting, active, delayed, failed] = await Promise.all([
        redis.llen(`bull:${q}:wait`),
        redis.llen(`bull:${q}:active`),
        redis.zcard(`bull:${q}:delayed`),
        redis.llen(`bull:${q}:failed`),
      ]);
      queueDepthGauge.set({ queue: q, state: 'waiting' }, waiting ?? 0);
      queueDepthGauge.set({ queue: q, state: 'active' }, active ?? 0);
      queueDepthGauge.set({ queue: q, state: 'delayed' }, delayed ?? 0);
      queueDepthGauge.set({ queue: q, state: 'failed' }, failed ?? 0);
    }
  }

}
