import { Worker, Queue, type Job } from 'bullmq';
import IORedis from 'ioredis';
import pino from 'pino';
import { Eventlog, RedisPubSub } from '@mergecrew/eventlog';
import { runStep } from './step.js';

const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  base: { service: 'runner' },
  ...(process.env.NODE_ENV !== 'production'
    ? { transport: { target: 'pino-pretty', options: { colorize: true } } }
    : {}),
});

const url = process.env.REDIS_URL ?? 'redis://localhost:6379';
const conn = new IORedis(url, { maxRetriesPerRequest: null });
const pubsub = new RedisPubSub(url);
const eventlog = new Eventlog(pubsub);
const replyQueue = new Queue('orchestrator.step-reply', { connection: conn });

const concurrency = Number(process.env.RUNNER_CONCURRENCY ?? 4);

const worker = new Worker(
  'runner.step',
  async (job: Job) => {
    const data = job.data as {
      organizationId: string;
      projectId: string;
      runId: string;
      workflowRunId: string;
      stepId: string;
      agentRef: string;
    };
    const outcome = await runStep({ ...data, eventlog, logger });
    await replyQueue.add('reply', { ...data, outcome }, { removeOnComplete: 1000 });
    return outcome;
  },
  { connection: conn, concurrency, autorun: true },
);

worker.on('failed', (job, err) => {
  logger.error({ jobId: job?.id, err: String(err?.message ?? err) }, 'step worker failed');
});

logger.info({ concurrency }, 'runner started');

async function shutdown() {
  logger.info('shutting down');
  await Promise.all([worker.close(), pubsub.close(), replyQueue.close(), conn.quit()]);
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
