#!/usr/bin/env node
import os from 'node:os';
import { logger } from './logger.js';
import {
  resolveAgentConfig,
  tokenPrefix,
  assertConfigUsable,
  type AgentConfig,
} from './config.js';

/**
 * `mergecrew/runner-agent` CLI entry (V2.af / #764).
 *
 * This release ships the skeleton only: arg parsing, config resolution,
 * and a `--dry-run` mode that prints the resolved config and exits 0.
 * The HTTP integration (long-poll loop, job execution) lands in #766.
 *
 * Usage:
 *   docker run mergecrew/runner-agent \
 *     --token mca_acme_XXXXXXXXXXXXXXXXXXXXXXXXXX \
 *     --api-url https://mergecrew.dev \
 *     --name homelab-1 \
 *     --driver docker
 */
function printHelp(): void {
  process.stdout.write(
    [
      'mergecrew/runner-agent — BYO runner agent (skeleton)',
      '',
      'Usage:',
      '  mergecrew-runner-agent --token <bearer> --api-url <url> [options]',
      '',
      'Options:',
      '  --token <bearer>       Enrollment bearer (or MERGECREW_AGENT_TOKEN).',
      '  --api-url <url>        Mergecrew API base URL (or MERGECREW_API_URL).',
      '  --name <name>          Display name in the org settings (default: hostname).',
      '  --driver <kind>        process | docker (default: docker).',
      '  --concurrency <n>      Parallel jobs to process (default: 1).',
      '  --dry-run              Print resolved config and exit.',
      '  --help                 Show this message.',
      '',
      'This is the skeleton release: --dry-run is the only supported mode.',
      'Job pull + execution lands in #766.',
      '',
    ].join('\n'),
  );
}

function printConfig(cfg: AgentConfig): void {
  // Use a plain console line rather than the pino logger so the dry-run
  // output stays human-friendly even with `LOG_LEVEL=info`. The
  // structured logger still gets the same payload one line down for
  // anyone consuming JSON logs.
  process.stdout.write('\n');
  process.stdout.write('Resolved runner-agent config:\n');
  process.stdout.write(`  name        : ${cfg.name}\n`);
  process.stdout.write(`  apiUrl      : ${cfg.apiUrl || '<unset>'}\n`);
  process.stdout.write(`  token       : ${tokenPrefix(cfg.token)}\n`);
  process.stdout.write(`  driver      : ${cfg.driver}\n`);
  process.stdout.write(`  concurrency : ${cfg.concurrency}\n`);
  process.stdout.write('\n');
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    printHelp();
    process.exit(0);
  }

  let cfg: AgentConfig;
  try {
    cfg = resolveAgentConfig({
      argv,
      env: process.env,
      hostname: () => os.hostname(),
    });
  } catch (err) {
    logger.error({ err: err instanceof Error ? err.message : err }, 'config error');
    process.exit(2);
  }

  if (cfg.dryRun) {
    logger.info(
      {
        name: cfg.name,
        apiUrl: cfg.apiUrl || null,
        tokenPrefix: tokenPrefix(cfg.token),
        driver: cfg.driver,
        concurrency: cfg.concurrency,
      },
      'runner-agent dry-run',
    );
    printConfig(cfg);
    process.exit(0);
  }

  try {
    assertConfigUsable(cfg);
  } catch (err) {
    logger.error({ err: err instanceof Error ? err.message : err }, 'config error');
    process.exit(2);
  }

  // #765/#766: hit /hello once to validate enrolment, then drop into
  // the long-poll loop. The agent pulls jobs from /poll (BRPOP-backed
  // on the deployment), heartbeats every 15s during a job, and posts
  // an outcome when done.
  //
  // The executor is a STUB for v1 — the agent acknowledges the job and
  // immediately reports `byo_executor_not_implemented`. Real BYO
  // execution (sandbox + skill orchestration) lands in follow-up #782.
  let stopped = false;
  process.on('SIGINT', () => {
    stopped = true;
  });
  process.on('SIGTERM', () => {
    stopped = true;
  });

  // Initial /hello — bail clearly on 401 so operators don't watch
  // /poll spin against a bad token.
  try {
    const helloRes = await callApi(cfg, '/v1/runner-agent/hello', { agentVersion: AGENT_VERSION });
    if (helloRes.status === 401) {
      logger.error('runner-agent: 401 from /hello — token revoked or unknown.');
      process.exit(4);
    }
    if (!helloRes.ok) {
      logger.warn({ status: helloRes.status }, 'hello: unexpected status, proceeding anyway');
    } else {
      const body = (await helloRes.json()) as { agentName?: string; orgSlug?: string };
      logger.info({ agentName: body.agentName, orgSlug: body.orgSlug }, 'agent online');
    }
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : err },
      'hello: request failed, proceeding to poll loop',
    );
  }

  while (!stopped) {
    let job: PolledJob | null = null;
    try {
      job = await pollNext(cfg);
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : err },
        'poll: request failed, will retry',
      );
      await sleep(POLL_BACKOFF_MS);
      continue;
    }
    if (!job) continue; // idle tick
    logger.info(
      { stepId: job.stepId, runId: job.runId, agentRef: job.agentRef },
      'agent: picked up job',
    );
    await runStubExecutor(cfg, job);
  }
}

interface PolledJob {
  organizationId: string;
  projectId: string;
  runId: string;
  workflowRunId: string;
  stepId: string;
  agentRef: string;
}

async function callApi(cfg: AgentConfig, path: string, body?: unknown): Promise<Response> {
  const url = new URL(path, cfg.apiUrl).toString();
  return fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${cfg.token}`,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function pollNext(cfg: AgentConfig): Promise<PolledJob | null> {
  const res = await callApi(cfg, `/v1/runner-agent/poll?timeout=${POLL_TIMEOUT_SEC}`);
  if (res.status === 401) {
    logger.error('runner-agent: 401 from /poll — token revoked or unknown.');
    process.exit(4);
  }
  if (!res.ok) {
    logger.warn({ status: res.status }, 'poll: unexpected status');
    return null;
  }
  const body = (await res.json()) as { kind: 'idle' } | ({ kind: 'job' } & PolledJob);
  if (body.kind === 'idle') return null;
  const { kind: _kind, ...job } = body;
  return job;
}

/**
 * Stub executor (v1, #766). Reports start, heartbeats once, then
 * reports `byo_executor_not_implemented`. Real execution lands in
 * follow-up #782 — see the EPIC for the architecture options.
 */
async function runStubExecutor(cfg: AgentConfig, job: PolledJob): Promise<void> {
  try {
    await callApi(cfg, `/v1/runner-agent/steps/${job.stepId}/events`, {
      type: 'AGENT_STEP_STARTED',
      payload: { agentRef: job.agentRef, executor: 'byo-stub-v1' },
    });
    await callApi(cfg, '/v1/runner-agent/heartbeat', { stepId: job.stepId });
    await callApi(cfg, `/v1/runner-agent/steps/${job.stepId}/outcome`, {
      kind: 'failed',
      reason: 'byo_executor_not_implemented',
    });
    logger.info({ stepId: job.stepId }, 'agent: reported stub outcome');
  } catch (err) {
    logger.warn(
      { stepId: job.stepId, err: err instanceof Error ? err.message : err },
      'agent: failed to report outcome — orchestrator will retry via heartbeat sweeper',
    );
  }
}

const AGENT_VERSION = '0.1.0';
const POLL_TIMEOUT_SEC = 30;
const POLL_BACKOFF_MS = 5_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((err) => {
  logger.error({ err: err instanceof Error ? err.message : err }, 'unhandled error');
  process.exit(1);
});
