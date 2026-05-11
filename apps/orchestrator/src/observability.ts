import http from 'node:http';
import client, { type Gauge } from 'prom-client';
import type { Redis as IORedis } from 'ioredis';
import type { Logger } from 'pino';

// Orchestrator-side observability surface (#224). Mirrors the api's
// prom-client registry so a single Prometheus scrape job can hit both
// services and split them on the `service` label.

export const registry = new client.Registry();
registry.setDefaultLabels({ service: 'orchestrator' });
client.collectDefaultMetrics({ register: registry });

export const queueDepthGauge: Gauge<string> = new client.Gauge({
  name: 'mergecrew_queue_depth',
  help: 'BullMQ queue depth split by state (waiting / active / delayed / failed).',
  labelNames: ['queue', 'state'],
  registers: [registry],
});

export const orchestratorTickAgeSeconds: Gauge<string> = new client.Gauge({
  name: 'mergecrew_orchestrator_tick_age_seconds',
  help: 'Seconds since the last successful heartbeat-sweeper tick.',
  registers: [registry],
});

let lastTickMs: number | null = null;

export function markTick(): void {
  lastTickMs = Date.now();
}

interface ServerOpts {
  port: number;
  redis: IORedis;
  /** Queues to sample for the `mergecrew_queue_depth` gauge. */
  queues: string[];
  /**
   * Healthz fails (503) when no successful tick has been recorded in this
   * many milliseconds. Default = 4× the configured sweeper interval, so a
   * single missed tick isn't enough to alarm.
   */
  staleTickMs: number;
  logger: Logger;
}

/**
 * Boot a small HTTP server (no framework) exposing /healthz + /metrics.
 * The orchestrator doesn't otherwise listen on HTTP — the server here is
 * scrape-only and the port is conventionally 9090 (Prometheus default).
 */
export function startObservabilityServer(opts: ServerOpts): http.Server {
  const server = http.createServer(async (req, res) => {
    try {
      const url = req.url ?? '/';
      if (url === '/healthz') {
        await handleHealth(req, res, opts);
        return;
      }
      if (url === '/metrics' || url === '/metrics/') {
        await handleMetrics(res, opts);
        return;
      }
      res.statusCode = 404;
      res.setHeader('content-type', 'text/plain');
      res.end('not found');
    } catch (err: any) {
      opts.logger.error({ err: err?.message ?? err }, 'observability server error');
      res.statusCode = 500;
      res.end('internal error');
    }
  });
  server.listen(opts.port, () => {
    opts.logger.info({ port: opts.port }, 'observability server listening');
  });
  return server;
}

async function handleHealth(_req: http.IncomingMessage, res: http.ServerResponse, opts: ServerOpts): Promise<void> {
  const checks: Record<string, 'ok' | 'fail'> = { redis: 'ok', tick: 'ok' };
  const details: Record<string, string> = {};

  try {
    const pong = await opts.redis.ping();
    if (pong !== 'PONG') {
      checks.redis = 'fail';
      details.redis = `ping returned ${pong}`;
    }
  } catch (err: any) {
    checks.redis = 'fail';
    details.redis = String(err?.message ?? err);
  }

  if (lastTickMs == null) {
    // Orchestrator just started — give the sweeper one interval to record
    // a tick before failing readiness.
    checks.tick = 'fail';
    details.tick = 'no successful tick yet';
  } else {
    const ageMs = Date.now() - lastTickMs;
    if (ageMs > opts.staleTickMs) {
      checks.tick = 'fail';
      details.tick = `last tick ${(ageMs / 1000).toFixed(1)}s ago, threshold ${(opts.staleTickMs / 1000).toFixed(1)}s`;
    }
  }

  const degraded = Object.values(checks).some((v) => v === 'fail');
  res.statusCode = degraded ? 503 : 200;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.end(
    JSON.stringify({
      status: degraded ? 'degraded' : 'ok',
      checks,
      ...(degraded ? { details } : {}),
    }),
  );
}

async function handleMetrics(res: http.ServerResponse, opts: ServerOpts): Promise<void> {
  await refreshQueueDepths(opts.redis, opts.queues).catch(() => {
    // Redis hiccup — exposition still returns the rest of the registry.
  });
  if (lastTickMs != null) {
    orchestratorTickAgeSeconds.set((Date.now() - lastTickMs) / 1000);
  }
  res.statusCode = 200;
  res.setHeader('content-type', registry.contentType);
  res.end(await registry.metrics());
}

async function refreshQueueDepths(redis: IORedis, queues: string[]): Promise<void> {
  for (const q of queues) {
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
