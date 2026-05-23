import { Controller, Get, HttpStatus, Res } from '@nestjs/common';
import type { Response } from 'express';
import { PrismaService } from '../../common/prisma.service.js';
import { QueueService } from '../../common/queue.service.js';
import { exposition, queueDepthGauge } from './metrics.js';

interface ReadyBody {
  status: 'ok' | 'degraded';
  checks: {
    db: 'ok' | 'fail';
    redis: 'ok' | 'fail';
  };
  details?: { db?: string; redis?: string };
}

const CHECK_TIMEOUT_MS = 500;

function withTimeout<T>(p: Promise<T>, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_resolve, reject) =>
      setTimeout(() => reject(new Error(`${label} check exceeded ${CHECK_TIMEOUT_MS}ms`)), CHECK_TIMEOUT_MS),
    ),
  ]);
}

// Liveness, readiness + Prometheus exposition. All three endpoints are
// unauthenticated by design — they're scraped by infra, not users — and
// sit at the root path (no /v1 prefix) so the existing API tenant
// middleware skips them.
@Controller()
export class HealthController {
  constructor(private prisma: PrismaService, private queue: QueueService) {}

  // Liveness: returns 200 as long as the process is up. Used by
  // kubelet to decide whether to restart the pod. Cheap — no I/O.
  @Get('healthz')
  healthz(): { ok: true } {
    return { ok: true };
  }

  // Readiness: 200 only when downstream dependencies are reachable.
  // Used by kubelet to decide whether to route traffic. Each check is
  // bounded at CHECK_TIMEOUT_MS so a hung dependency doesn't block the
  // probe past the kubelet's own timeout (kubelet default = 1s).
  @Get('readyz')
  async readyz(@Res({ passthrough: true }) res: Response): Promise<ReadyBody> {
    const body: ReadyBody = {
      status: 'ok',
      checks: { db: 'ok', redis: 'ok' },
    };
    const details: { db?: string; redis?: string } = {};

    try {
      await withTimeout(
        // eslint-disable-next-line no-restricted-syntax -- `select 1` healthcheck, no input. See docs/02-architecture/11-security.md § Raw SQL allowlist.
        this.prisma.withSystem((tx) => tx.$queryRaw`select 1`),
        'db',
      );
    } catch (e: any) {
      body.checks.db = 'fail';
      details.db = String(e?.message ?? e);
    }

    try {
      const pong = await withTimeout(this.queue.connectionHandle().ping(), 'redis');
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
      'runner.step.instance',
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
