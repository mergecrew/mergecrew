import { Queue, Worker, type Job } from 'bullmq';
import IORedis from 'ioredis';
import pino from 'pino';
import { Eventlog, RedisPubSub, fanoutToBullmq, type FanoutPayload } from '@mergecrew/eventlog';
import { Orchestrator } from './orchestrator.js';
import { deliverOutboundWebhook, type OutboundJob } from './outbound-webhook-worker.js';
import { handleFanout } from './webhook-fanout-worker.js';
import { HeartbeatSweeper } from './heartbeat-sweeper.js';

const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  base: { service: 'orchestrator' },
  ...(process.env.NODE_ENV !== 'production'
    ? { transport: { target: 'pino-pretty', options: { colorize: true } } }
    : {}),
});

const url = process.env.REDIS_URL ?? 'redis://localhost:6379';
const conn = new IORedis(url, { maxRetriesPerRequest: null });
const pubsub = new RedisPubSub(url);
const fanoutQueue = new Queue('webhook.fanout', { connection: conn });
const outboundQueue = new Queue('webhook.outbound', { connection: conn });
const eventlog = new Eventlog(pubsub, fanoutToBullmq(fanoutQueue));

const orchestrator = new Orchestrator({ connection: conn, eventlog, logger });

// Wakers: when a step times out / rate limit elapses, jobs reappear here.
const dueWorker = new Worker(
  'run.due',
  async (job: Job) => orchestrator.handleRunDue(job.data),
  { connection: conn, concurrency: 4 },
);

const dispatchWorker = new Worker(
  'orchestrator.dispatch',
  async (job: Job) => orchestrator.handleDispatch(job.name, job.data),
  { connection: conn, concurrency: 8 },
);

const gateWorker = new Worker(
  'orchestrator.gate.resume',
  async (job: Job) => orchestrator.resumeGate(job.data),
  { connection: conn, concurrency: 4 },
);

const rateWorker = new Worker(
  'orchestrator.rate-limit.resume',
  async (job: Job) => orchestrator.resumeRateLimit(job.data),
  { connection: conn, concurrency: 4 },
);

const webhookWorker = new Worker(
  'webhook.inbound',
  async (job: Job) => orchestrator.handleWebhook(job.name, job.data),
  { connection: conn, concurrency: 8 },
);

const stepReplyWorker = new Worker(
  'orchestrator.step-reply',
  async (job: Job) => orchestrator.onStepReply(job.data),
  { connection: conn, concurrency: 16 },
);

// Org-cap deferred dispatches (V1.3, #9). When dispatchAgentStep finds the
// org at its concurrency cap it delays the dispatch onto this queue;
// processing here re-enters the dispatch path.
const orgCapWaitWorker = new Worker(
  'orchestrator.org-cap-wait',
  async (job: Job) => orchestrator.handleOrgCapWait(job.data),
  { connection: conn, concurrency: 4 },
);

const digestWorker = new Worker(
  'digest.dispatch',
  async (job: Job) => orchestrator.handleDigestDispatch(job.data),
  { connection: conn, concurrency: 4 },
);

const digestSlackWorker = new Worker(
  'digest.slack',
  async (job: Job) => orchestrator.handleSlackDigest(job.data),
  { connection: conn, concurrency: 2 },
);

const digestEmailWorker = new Worker(
  'digest.email',
  async (job: Job) => orchestrator.handleEmailDigest(job.data),
  { connection: conn, concurrency: 2 },
);

// Outbound webhook delivery (#141 / #142). BullMQ owns retries — the
// worker throws on non-2xx and the queue's exponential backoff fires.
// Backoff schedule: 1s, 4s, 16s, 1m, 5m, 30m, drop (after 6 attempts).
const outboundWebhookWorker = new Worker<OutboundJob>(
  'webhook.outbound',
  async (job) => deliverOutboundWebhook(job.data, logger, job.attemptsMade + 1),
  { connection: conn, concurrency: 8 },
);

// Eventlog fanout (#148): every persisted event lands here. Worker fetches
// matching webhooks and enqueues per-webhook delivery jobs onto outbound.
const fanoutWorker = new Worker<FanoutPayload>(
  'webhook.fanout',
  async (job) => handleFanout(job.data, outboundQueue, logger),
  { connection: conn, concurrency: 4 },
);

// Heartbeat sweeper (#10 V1.4): re-dispatches steps whose runner stopped
// writing heartbeats. Reuses the same `runner.step` queue the orchestrator
// dispatches to.
const runnerQueue = new Queue('runner.step', { connection: conn });
const heartbeatSweeper = new HeartbeatSweeper({
  runnerQueue,
  eventlog,
  logger,
  intervalMs: Number(process.env.ORCHESTRATOR_HEARTBEAT_SWEEPER_INTERVAL_MS ?? 30_000),
  staleAfterMs: Number(process.env.ORCHESTRATOR_HEARTBEAT_STALE_AFTER_MS ?? 90_000),
  maxAttempts: Number(process.env.ORCHESTRATOR_HEARTBEAT_MAX_ATTEMPTS ?? 3),
});
heartbeatSweeper.start();

logger.info('orchestrator started');

async function shutdown() {
  logger.info('shutting down');
  heartbeatSweeper.stop();
  await Promise.all([
    dueWorker.close(),
    dispatchWorker.close(),
    gateWorker.close(),
    rateWorker.close(),
    webhookWorker.close(),
    stepReplyWorker.close(),
    orgCapWaitWorker.close(),
    digestWorker.close(),
    digestSlackWorker.close(),
    digestEmailWorker.close(),
    outboundWebhookWorker.close(),
    fanoutWorker.close(),
    fanoutQueue.close(),
    outboundQueue.close(),
    runnerQueue.close(),
    pubsub.close(),
    conn.quit(),
  ]);
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
