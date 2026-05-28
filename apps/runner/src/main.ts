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
import { buildSandboxDriver, buildSandboxDriverAsync, HttpSandboxDriver } from '@mergecrew/sandbox-driver';
import { withSystem } from '@mergecrew/db';
import { launchFargateAgent } from './fargate-byo-launcher.js';
import { launchGithubActionsWorkflow } from './github-actions-launcher.js';

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
  fargateRegion: process.env.RUNNER_FARGATE_REGION,
  fargateCluster: process.env.RUNNER_FARGATE_CLUSTER,
  fargateTaskDefinition: process.env.RUNNER_FARGATE_TASK_DEFINITION,
  fargateSubnets: process.env.RUNNER_FARGATE_SUBNETS,
  fargateSecurityGroups: process.env.RUNNER_FARGATE_SG,
  fargateDefaultImage: process.env.RUNNER_FARGATE_DEFAULT_IMAGE,
  logger,
};
const needsAsync = /^(kubernetes|k8s|fargate)$/.test(
  (process.env.RUNNER_SANDBOX ?? '').toLowerCase(),
);
const driverPromise: Promise<ReturnType<typeof buildSandboxDriver>> = needsAsync
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

type RunnerStepJob = {
  organizationId: string;
  projectId: string;
  runId: string;
  workflowRunId: string;
  stepId: string;
  agentRef: string;
  /**
   * V2.ag (ADR-0009). Selects the SandboxDriver shape per-step.
   *
   *   'local'           (default) — RUNNER_SANDBOX-selected host driver.
   *   'agent'           — HttpSandboxDriver against a BYO agent that
   *                       the user runs on their own machine. The
   *                       orchestrator LPUSHes a claim onto the
   *                       org's agent queue before enqueueing here.
   *   'fargate-byo'     — Same as 'agent' from the runStep view, but
   *                       the supervisor first launches an ECS task
   *                       in the user's AWS account that runs
   *                       `mergecrew/runner-agent` (#786).
   *   'github-actions'  — Same as 'agent' from the runStep view, but
   *                       the supervisor first calls
   *                       `workflow_dispatch` on the user's repo to
   *                       launch a one-shot agent inside a GHA
   *                       runner (#772).
   */
  executor?: 'local' | 'agent' | 'fargate-byo' | 'github-actions';
};

async function handleStepJob(data: RunnerStepJob) {
  const executor = data.executor ?? 'local';
  const isRemoteAgent =
    executor === 'agent' || executor === 'fargate-byo' || executor === 'github-actions';
  let driver;
  let fargateTaskArn: string | undefined;
  if (executor === 'fargate-byo') {
    fargateTaskArn = await launchFargateForStep(data);
    driver = buildAgentDriverForStep(data.stepId);
  } else if (executor === 'github-actions') {
    await launchGithubActionsForStep(data);
    driver = buildAgentDriverForStep(data.stepId);
  } else if (executor === 'agent') {
    driver = buildAgentDriverForStep(data.stepId);
  } else {
    driver = await driverPromise;
  }
  try {
    const outcome = await runStep({
      ...data,
      // From runStep's perspective all three remote-agent paths are
      // identical (it talks to HttpSandboxDriver). The supervisor
      // wrinkles (ECS launch, GHA dispatch) happen above.
      executor: isRemoteAgent ? 'agent' : executor,
      eventlog,
      logger,
      cancellation,
      driver,
    });
    await replyQueue.add('reply', { ...data, outcome }, { removeOnComplete: 1000 });
    return outcome;
  } finally {
    if (isRemoteAgent) {
      // V2.ag: signal the BYO agent's sandbox-ops loop to exit
      // immediately. KEY MUST MATCH `opsKey()` in
      // apps/api/src/modules/runner-agent/sandbox-ops.service.ts.
      const SENTINEL = { opId: 'done', op: 'step-done', args: {} };
      await conn
        .lpush(`runner-agent:sandbox-ops:${data.stepId}`, JSON.stringify(SENTINEL))
        .catch((err: unknown) => {
          logger.warn(
            { stepId: data.stepId, err: err instanceof Error ? err.message : err },
            'step-done sentinel push failed — agent will exit on idle heuristic instead',
          );
        });
    }
    if (fargateTaskArn) {
      // Best-effort task-arn log only. The Fargate task exits when
      // the agent process inside it exits (the runner-agent loop
      // returns after step-done). We don't actively StopTask
      // because the agent's clean shutdown is the contract.
      logger.info(
        { stepId: data.stepId, taskArn: fargateTaskArn },
        'fargate-byo: step complete; ECS task will exit when agent does',
      );
    }
  }
}

async function launchGithubActionsForStep(data: RunnerStepJob): Promise<void> {
  const apiBaseUrl = (process.env.MERGECREW_API_BASE_URL ?? process.env.API_BASE_URL ?? '').trim();
  if (!apiBaseUrl) {
    throw new Error(
      'MERGECREW_API_BASE_URL is required on the supervisor to dispatch github-actions workflows',
    );
  }
  const profile = await withSystem((tx) =>
    tx.runnerProfile.findUnique({
      where: { organizationId: data.organizationId },
      select: {
        kind: true,
        githubRepoFullName: true,
        githubWorkflowFileName: true,
        githubTokenCiphertext: true,
        organization: { select: { slug: true } },
      },
    }),
  );
  if (!profile || profile.kind !== 'github_actions') {
    throw new Error(
      `github-actions: org ${data.organizationId} is not on the github_actions profile (got ${profile?.kind ?? 'none'})`,
    );
  }
  if (
    !profile.githubRepoFullName ||
    !profile.githubWorkflowFileName ||
    !profile.githubTokenCiphertext
  ) {
    throw new Error(
      'github-actions: profile is missing required fields (githubRepoFullName / githubWorkflowFileName / githubTokenCiphertext)',
    );
  }
  await launchGithubActionsWorkflow({
    organizationId: data.organizationId,
    organizationSlug: profile.organization.slug,
    stepId: data.stepId,
    runId: data.runId,
    profile: {
      githubRepoFullName: profile.githubRepoFullName,
      githubWorkflowFileName: profile.githubWorkflowFileName,
      githubTokenCiphertext: profile.githubTokenCiphertext,
    },
    apiBaseUrl,
    logger,
  });
}

async function launchFargateForStep(data: RunnerStepJob): Promise<string> {
  const apiBaseUrl = (process.env.MERGECREW_API_BASE_URL ?? process.env.API_BASE_URL ?? '').trim();
  if (!apiBaseUrl) {
    throw new Error(
      'MERGECREW_API_BASE_URL is required on the supervisor to launch fargate-byo tasks',
    );
  }
  // Look up the org's runner_profile so we know which AWS account
  // and ECS task to launch. The orchestrator already validated kind
  // = 'fargate_byo' at dispatch time; we read the per-kind config
  // here.
  const profile = await withSystem((tx) =>
    tx.runnerProfile.findUnique({
      where: { organizationId: data.organizationId },
      select: {
        kind: true,
        awsRoleArn: true,
        awsExternalId: true,
        awsRegion: true,
        fargateCluster: true,
        fargateTaskDefinition: true,
        fargateSubnets: true,
        fargateSecurityGroups: true,
        organization: { select: { slug: true } },
      },
    }),
  );
  if (!profile || profile.kind !== 'fargate_byo') {
    throw new Error(
      `fargate-byo: org ${data.organizationId} is not on the fargate_byo profile (got ${profile?.kind ?? 'none'})`,
    );
  }
  if (
    !profile.awsRoleArn ||
    !profile.awsExternalId ||
    !profile.awsRegion ||
    !profile.fargateCluster ||
    !profile.fargateTaskDefinition
  ) {
    throw new Error(
      'fargate-byo: profile is missing required AWS fields (awsRoleArn / awsExternalId / awsRegion / fargateCluster / fargateTaskDefinition)',
    );
  }
  const { taskArn } = await launchFargateAgent({
    organizationId: data.organizationId,
    organizationSlug: profile.organization.slug,
    stepId: data.stepId,
    runId: data.runId,
    profile: {
      awsRoleArn: profile.awsRoleArn,
      awsExternalId: profile.awsExternalId,
      awsRegion: profile.awsRegion,
      fargateCluster: profile.fargateCluster,
      fargateTaskDefinition: profile.fargateTaskDefinition,
      fargateSubnets: profile.fargateSubnets,
      fargateSecurityGroups: profile.fargateSecurityGroups,
    },
    apiBaseUrl,
    logger,
  });
  return taskArn;
}

function buildAgentDriverForStep(stepId: string): HttpSandboxDriver {
  const baseUrl = (process.env.MERGECREW_API_BASE_URL ?? process.env.API_BASE_URL ?? '').trim();
  const authToken = (process.env.MERGECREW_INTERNAL_TOKEN ?? '').trim();
  if (!baseUrl) {
    throw new Error(
      'MERGECREW_API_BASE_URL (or API_BASE_URL) is required on the supervisor to drive agent-profile steps',
    );
  }
  if (!authToken) {
    throw new Error(
      'MERGECREW_INTERNAL_TOKEN is required on the supervisor to authenticate sandbox-op dispatch',
    );
  }
  return new HttpSandboxDriver({ baseUrl, authToken, stepId });
}

// Consumes the V2.af `instance_builtin` profile queue (ADR-0005).
const worker = new Worker(
  'runner.step.instance',
  async (job: Job) => handleStepJob(job.data as RunnerStepJob),
  { connection: conn, concurrency, autorun: true },
);

// Legacy `runner.step` consumer — one-release bridge for deployments
// upgrading from before the V2.af rename. Drains any in-flight jobs
// from the pre-rename queue. Remove in the next minor release after
// confirming no production queues retain backlog under this name.
const legacyWorker = new Worker(
  'runner.step',
  async (job: Job) => {
    logger.warn(
      { stepId: (job.data as RunnerStepJob)?.stepId },
      'runner.step legacy queue job picked up — upgrading deployment? Remove the bridge worker after one release.',
    );
    return handleStepJob(job.data as RunnerStepJob);
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
    legacyWorker.close(),
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
