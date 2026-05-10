import { Worker, Queue, type Job } from 'bullmq';
import IORedis from 'ioredis';
import pino from 'pino';
import {
  Eventlog,
  RedisPubSub,
  fanoutToBullmq,
  RUN_CANCEL_CHANNEL,
  type RunCancelMessage,
} from '@mergecrew/eventlog';
import { withTenant } from '@mergecrew/db';
import { runStep } from './step.js';
import { CancellationCoordinator } from './cancellation.js';

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
const fanoutQueue = new Queue('webhook.fanout', { connection: conn });
const eventlog = new Eventlog(pubsub, fanoutToBullmq(fanoutQueue));
const replyQueue = new Queue('orchestrator.step-reply', { connection: conn });

const concurrency = Number(process.env.RUNNER_CONCURRENCY ?? 4);

// V1.3 cancellation propagation (#9). The API publishes on
// RUN_CANCEL_CHANNEL when a user cancels a run; we abort every in-flight
// step's AbortController, and the agent runtime returns a 'cancelled'
// outcome which the orchestrator translates into agent_step status.
const cancellation = new CancellationCoordinator();
let cancelUnsub: (() => Promise<void>) | undefined;
pubsub
  .subscribe<RunCancelMessage>(RUN_CANCEL_CHANNEL, (msg) => {
    if (!msg?.runId) return;
    const aborted = cancellation.cancelRun(msg.runId, msg.reason);
    if (aborted > 0) {
      logger.info(
        { runId: msg.runId, aborted, reason: msg.reason },
        'cancellation: aborted in-flight steps',
      );
    }
  })
  .then((unsub) => {
    cancelUnsub = unsub;
  })
  .catch((err) => {
    logger.error(
      { err: err?.message ?? err },
      'cancellation: failed to subscribe — cancel button will only stop newly-dispatched steps',
    );
  });

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
    const outcome = await runStep({ ...data, eventlog, logger, cancellation });
    await replyQueue.add('reply', { ...data, outcome }, { removeOnComplete: 1000 });
    return outcome;
  },
  { connection: conn, concurrency, autorun: true },
);

worker.on('failed', (job, err) => {
  logger.error({ jobId: job?.id, err: String(err?.message ?? err) }, 'step worker failed');
  // If runStep threw before reaching its terminal cleanup, the heartbeat
  // and status would be stuck mid-flight. Stamp a terminal heartbeatAt of
  // null so the orchestrator's sweeper doesn't keep "recovering" a step
  // that's already abandoned, and surface the error to operators via
  // the agent_steps row. Best-effort — DB outage during shutdown is OK,
  // the sweeper will eventually pick up.
  const data = job?.data as { organizationId?: string; stepId?: string } | undefined;
  if (data?.organizationId && data.stepId) {
    withTenant(data.organizationId, (tx) =>
      tx.agentStep.updateMany({
        where: { id: data.stepId, status: 'running' },
        data: {
          status: 'failed',
          finishedAt: new Date(),
          heartbeatAt: null,
          failureReason: `runner_threw: ${String(err?.message ?? err).slice(0, 500)}`,
        },
      }),
    ).catch((dbErr: any) =>
      logger.warn({ stepId: data.stepId, dbErr: dbErr?.message ?? dbErr }, 'failed to mark step as failed'),
    );
  }
});

logger.info({ concurrency }, 'runner started');

async function shutdown() {
  logger.info('shutting down');
  if (cancelUnsub) {
    await cancelUnsub().catch(() => {});
  }
  await Promise.all([
    worker.close(),
    pubsub.close(),
    replyQueue.close(),
    fanoutQueue.close(),
    conn.quit(),
  ]);
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
