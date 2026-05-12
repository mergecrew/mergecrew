/**
 * Minimal liveness/readiness HTTP server for worker-cron (#317).
 * worker-cron has no other HTTP surface today — this exists purely so
 * the docker compose `service_healthy` gate + kubelet probes have
 * something to scrape. /healthz never touches I/O so the kubelet never
 * gets a stuck process answering "ok"; /readyz pings Redis with a
 * tight timeout so a hung Redis flips readiness inside the kubelet's
 * own deadline.
 */

import http from 'node:http';
import type { Redis as IORedis } from 'ioredis';
import type { Logger } from 'pino';

const READY_TIMEOUT_MS = 500;

function withTimeout<T>(p: Promise<T>, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_resolve, reject) =>
      setTimeout(
        () => reject(new Error(`${label} check exceeded ${READY_TIMEOUT_MS}ms`)),
        READY_TIMEOUT_MS,
      ),
    ),
  ]);
}

export function startProbeServer(opts: {
  port: number;
  redis: IORedis;
  logger: Logger;
}): http.Server {
  const server = http.createServer(async (req, res) => {
    const url = req.url ?? '/';
    if (url === '/healthz') {
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (url === '/readyz') {
      let redisOk = true;
      let detail: string | undefined;
      try {
        const pong = await withTimeout(opts.redis.ping(), 'redis');
        if (pong !== 'PONG') {
          redisOk = false;
          detail = `redis ping returned ${pong}`;
        }
      } catch (err: any) {
        redisOk = false;
        detail = String(err?.message ?? err);
      }
      res.statusCode = redisOk ? 200 : 503;
      res.setHeader('content-type', 'application/json; charset=utf-8');
      res.end(
        JSON.stringify({
          status: redisOk ? 'ok' : 'degraded',
          checks: { redis: redisOk ? 'ok' : 'fail' },
          ...(detail ? { details: { redis: detail } } : {}),
        }),
      );
      return;
    }
    res.statusCode = 404;
    res.setHeader('content-type', 'text/plain');
    res.end('not found');
  });
  server.on('error', (err) => {
    opts.logger.error({ err: String(err.message ?? err) }, 'probe server error');
  });
  server.listen(opts.port, () => {
    opts.logger.info({ port: opts.port }, 'probe server listening');
  });
  return server;
}
