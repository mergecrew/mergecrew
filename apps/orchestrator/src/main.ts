import { Worker, type Job } from 'bullmq';
import IORedis from 'ioredis';
import pino from 'pino';
import { Eventlog, RedisPubSub } from '@mergecrew/eventlog';
import { Orchestrator } from './orchestrator.js';
import { deliverOutboundWebhook, type OutboundJob } from './outbound-webhook-worker.js';

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
const eventlog = new Eventlog(pubsub);

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

logger.info('orchestrator started');

async function shutdown() {
  logger.info('shutting down');
  await Promise.all([
    dueWorker.close(),
    dispatchWorker.close(),
    gateWorker.close(),
    rateWorker.close(),
    webhookWorker.close(),
    stepReplyWorker.close(),
    digestWorker.close(),
    digestSlackWorker.close(),
    digestEmailWorker.close(),
    outboundWebhookWorker.close(),
    pubsub.close(),
    conn.quit(),
  ]);
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
