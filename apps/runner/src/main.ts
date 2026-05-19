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
import { startProbeServer } from './probe-server.js';
import { cleanupWorkspace, WORKSPACE_CLEANUP_QUEUE } from './workspace.js';
import { buildSandboxDriver, buildSandboxDriverAsync } from '@mergecrew/sandbox-driver';

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

// Build the sandbox driver once at supervisor startup. Today the default
// (`process`) preserves the v0 execa-on-host behavior; once #557 lands an
// operator flips to `docker` via the RUNNER_SANDBOX env. The driver is
// threaded through every step's SkillExecutionContext.
// Async path so the k8s driver can lazy-import `@kubernetes/client-node`
// (#577) — process + docker modes return synchronously and bypass the
// import. Promise resolution happens before the worker starts consuming.
const driverFactoryOpts = {
  mode: process.env.RUNNER_SANDBOX,
  defaultImage: process.env.RUNNER_DEFAULT_IMAGE,
  ociRuntime: process.env.RUNNER_OCI_RUNTIME,
  dockerBin: process.env.RUNNER_DOCKER_BIN,
  egressNetwork: process.env.RUNNER_EGRESS_NETWORK,
  dnsResolver: process.env.RUNNER_DNS_RESOLVER,
  k8sNamespace: process.env.RUNNER_K8S_NAMESPACE,
  k8sAuth: (process.env.RUNNER_K8S_AUTH === 'in-cluster' ? 'in-cluster' : 'default') as
    | 'default'
    | 'in-cluster',
  k8sDefaultImage: process.env.RUNNER_K8S_DEFAULT_IMAGE,
  logger,
};
const isK8s = /^(kubernetes|k8s)$/.test((process.env.RUNNER_SANDBOX ?? '').toLowerCase());
const driverPromise: Promise<ReturnType<typeof buildSandboxDriver>> = isK8s
  ? buildSandboxDriverAsync(driverFactoryOpts)
  : Promise.resolve(buildSandboxDriver(driverFactoryOpts));

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
    const driver = await driverPromise;
    const outcome = await runStep({ ...data, eventlog, logger, cancellation, driver });
    await replyQueue.add('reply', { ...data, outcome }, { removeOnComplete: 1000 });
    return outcome;
  },
  { connection: conn, concurrency, autorun: true },
);

// Run-terminal workspace cleanup. The orchestrator (on done) and the API
// (on cancel) enqueue one job per terminated run; the handler rms the
// per-run workspace dir. Concurrency is intentionally low — these are
// rare events and a slow rm shouldn't starve the step worker.
const cleanupWorker = new Worker(
  WORKSPACE_CLEANUP_QUEUE,
  async (job: Job) => {
    const data = job.data as { runId: string };
    if (!data?.runId) return;
    await cleanupWorkspace({ runId: data.runId, logger });
  },
  { connection: conn, concurrency: 2, autorun: true },
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

const probePort = Number(process.env.RUNNER_HEALTH_PORT ?? 9091);
const probeServer = startProbeServer({ port: probePort, redis: conn, logger });

driverPromise
  .then((d) =>
    logger.info({ concurrency, sandboxDriver: d.name }, 'runner started'),
  )
  .catch((err) => {
    logger.error({ err: err?.message ?? err }, 'sandbox driver init failed; exiting');
    process.exit(1);
  });

async function shutdown() {
  logger.info('shutting down');
  if (cancelUnsub) {
    await cancelUnsub().catch(() => {});
  }
  probeServer.close();
  await Promise.all([
    worker.close(),
    cleanupWorker.close(),
    pubsub.close(),
    replyQueue.close(),
    fanoutQueue.close(),
    conn.quit(),
  ]);
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
