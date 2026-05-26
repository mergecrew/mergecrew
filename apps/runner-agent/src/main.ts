#!/usr/bin/env node
import os from 'node:os';
import { logger as rootLogger, type Logger } from './logger.js';
import {
  resolveAgentConfig,
  tokenPrefix,
  assertConfigUsable,
  type AgentConfig,
} from './config.js';
import { runSandboxOpsLoop } from './sandbox-ops-executor.js';

/**
 * `mergecrew/runner-agent` CLI entry (V2.af / #764 + #774).
 *
 * Multi-token (#774): one process can host N parallel pollers, each
 * bound to a single token (one per org). The pollers run
 * independently — a stalled or busy poller for org A doesn't slow
 * down org B. Specify with repeated `--token` or with
 * `MERGECREW_AGENT_TOKENS=a,b,c`.
 *
 * Usage:
 *   docker run mergecrew/runner-agent \
 *     --token mca_acme_XXXXXXXXXXXXXXXXXXXXXXXXXX \
 *     --api-url https://mergecrew.dev \
 *     --name homelab-1 \
 *     --driver docker
 *
 * Multi-org example:
 *   docker run mergecrew/runner-agent \
 *     --token mca_acme_AAA... \
 *     --token mca_beta_BBB... \
 *     --api-url https://mergecrew.dev
 */
function printHelp(): void {
  process.stdout.write(
    [
      'mergecrew/runner-agent — BYO runner agent',
      '',
      'Usage:',
      '  mergecrew-runner-agent --token <bearer> --api-url <url> [options]',
      '',
      'Options:',
      '  --token <bearer>       Enrollment bearer; may be repeated for multi-org',
      '                         (or MERGECREW_AGENT_TOKEN[S]).',
      '  --api-url <url>        Mergecrew API base URL (or MERGECREW_API_URL).',
      '  --name <name>          Display name in the org settings (default: hostname).',
      '  --driver <kind>        process | docker (default: docker).',
      '  --concurrency <n>      Parallel jobs per token (default: 1).',
      '  --dry-run              Print resolved config and exit.',
      '  --help                 Show this message.',
      '',
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
  process.stdout.write(`  tokens      : ${cfg.tokens.length} (${cfg.tokens.map(tokenPrefix).join(', ')})\n`);
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
    rootLogger.error({ err: err instanceof Error ? err.message : err }, 'config error');
    process.exit(2);
  }

  if (cfg.dryRun) {
    rootLogger.info(
      {
        name: cfg.name,
        apiUrl: cfg.apiUrl || null,
        tokenPrefixes: cfg.tokens.map(tokenPrefix),
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
    rootLogger.error({ err: err instanceof Error ? err.message : err }, 'config error');
    process.exit(2);
  }

  // Stop signal is shared across all pollers — SIGINT/SIGTERM
  // tells every token to wind down. Promise.all on the pollers
  // resolves once they all see the flag flip + complete their
  // in-flight step.
  const stopped = { value: false };
  process.on('SIGINT', () => {
    stopped.value = true;
  });
  process.on('SIGTERM', () => {
    stopped.value = true;
  });

  rootLogger.info(
    { tokens: cfg.tokens.length, apiUrl: cfg.apiUrl },
    `agent starting with ${cfg.tokens.length} token${cfg.tokens.length === 1 ? '' : 's'}`,
  );

  await Promise.all(
    cfg.tokens.map((token) => runPollerForToken(cfg, token, () => stopped.value)),
  );

  rootLogger.info('agent shutdown complete');
}

interface PolledJob {
  organizationId: string;
  projectId: string;
  runId: string;
  workflowRunId: string;
  stepId: string;
  agentRef: string;
}

/**
 * One poller's lifecycle: /hello, then long-poll forever (or until
 * stopped), processing one job at a time.
 *
 * A per-poller logger carries the token prefix as a base field so
 * multi-org operators can grep their logs by org without reading
 * full tokens. Multiple pollers' lines interleave but stay
 * distinguishable.
 */
async function runPollerForToken(
  cfg: AgentConfig,
  token: string,
  isStopped: () => boolean,
): Promise<void> {
  const log = rootLogger.child({ token: tokenPrefix(token) });

  try {
    const helloRes = await callApi(cfg, token, '/v1/runner-agent/hello', {
      agentVersion: AGENT_VERSION,
    });
    if (helloRes.status === 401) {
      log.error('401 from /hello — token revoked or unknown; this poller will exit');
      return;
    }
    if (!helloRes.ok) {
      log.warn({ status: helloRes.status }, 'hello: unexpected status, proceeding anyway');
    } else {
      const body = (await helloRes.json()) as { agentName?: string; orgSlug?: string };
      log.info({ agentName: body.agentName, orgSlug: body.orgSlug }, 'agent online');
    }
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : err },
      'hello: request failed, proceeding to poll loop',
    );
  }

  while (!isStopped()) {
    let job: PolledJob | null = null;
    try {
      job = await pollNext(cfg, token, log);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // 401 from /poll is terminal for this token — keep retrying
      // would spam the API. Other tokens are unaffected because
      // they each have their own runPollerForToken.
      if (msg.includes('401 unauthorized')) {
        return;
      }
      log.warn({ err: msg }, 'poll: request failed, will retry');
      await sleep(POLL_BACKOFF_MS);
      continue;
    }
    if (!job) continue;
    log.info(
      { stepId: job.stepId, runId: job.runId, agentRef: job.agentRef },
      'picked up job — switching to sandbox-ops mode',
    );
    await runSandboxOpsLoop({
      cfg,
      token,
      stepId: job.stepId,
      logger: log,
      isStopped,
    });
  }
}

async function callApi(
  cfg: AgentConfig,
  token: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  const url = new URL(path, cfg.apiUrl).toString();
  return fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function pollNext(
  cfg: AgentConfig,
  token: string,
  log: Logger,
): Promise<PolledJob | null> {
  const res = await callApi(cfg, token, `/v1/runner-agent/poll?timeout=${POLL_TIMEOUT_SEC}`);
  if (res.status === 401) {
    log.error('401 from /poll — token revoked or unknown; this poller will exit');
    // Throw so the caller breaks out — we don't want to exit the
    // whole process when one token of N goes bad.
    throw new Error('poll: 401 unauthorized');
  }
  if (!res.ok) {
    log.warn({ status: res.status }, 'poll: unexpected status');
    return null;
  }
  const body = (await res.json()) as { kind: 'idle' } | ({ kind: 'job' } & PolledJob);
  if (body.kind === 'idle') return null;
  const { kind: _kind, ...job } = body;
  return job;
}

const AGENT_VERSION = '0.1.0';
const POLL_TIMEOUT_SEC = 30;
const POLL_BACKOFF_MS = 5_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((err) => {
  rootLogger.error({ err: err instanceof Error ? err.message : err }, 'unhandled error');
  process.exit(1);
});
