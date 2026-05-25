import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildSandboxDriverAsync,
  type SandboxDriver,
  type SandboxHandle,
  type SandboxStartOpts,
  type ExecOpts,
} from '@mergecrew/sandbox-driver';
import type { AgentConfig } from './config.js';
import type { Logger } from './logger.js';

/**
 * Agent-side executor for the V2.ag BYO step (ADR-0009 step 3).
 *
 * Once the agent claims a job via /poll, it stops polling /poll and
 * switches into "sandbox-ops mode" for that stepId — long-polls the
 * deployment for SandboxDriver ops the supervisor is emitting via
 * HttpSandboxDriver, executes each op against a local SandboxDriver
 * (process or docker, per the agent's --driver), and posts results.
 *
 * The loop exits when:
 *
 *   - The agent receives `MAX_CONSECUTIVE_IDLES` idle responses in a
 *     row (~heuristic for "supervisor finished this step"). The
 *     supervisor-side stop signal is step 4; this is the placeholder.
 *   - `stop()` was requested (SIGINT/SIGTERM).
 *
 * The agent does NOT report step events / outcome — those are now
 * the supervisor's responsibility (the supervisor runs `runStep` and
 * the agent is just its sandbox).
 */

interface OpEnvelope {
  opId: string;
  op: string;
  args: unknown;
}

interface PollOpsResponse {
  kind: 'idle' | 'op';
  opId?: string;
  op?: string;
  args?: unknown;
}

const MAX_CONSECUTIVE_IDLES = 5;
const SANDBOX_OP_POLL_TIMEOUT_SEC = 30;

export interface SandboxOpsLoopDeps {
  cfg: AgentConfig;
  stepId: string;
  logger: Logger;
  isStopped: () => boolean;
}

export async function runSandboxOpsLoop(deps: SandboxOpsLoopDeps): Promise<void> {
  const { cfg, stepId, logger, isStopped } = deps;
  const driver = await buildLocalDriver(cfg);
  let handle: SandboxHandle | null = null;
  let idles = 0;

  try {
    while (!isStopped() && idles < MAX_CONSECUTIVE_IDLES) {
      const popped = await pollNextOp(cfg, stepId, logger);
      if (!popped) {
        idles++;
        continue;
      }
      idles = 0;

      try {
        const result = await executeOp(driver, handle, popped, logger);
        if (popped.op === 'start') {
          handle = result as SandboxHandle;
        }
        await postOpResult(cfg, stepId, popped.opId, { ok: true, result }, logger);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.warn(
          { stepId, opId: popped.opId, op: popped.op, err: message },
          'agent: sandbox op execution failed; reporting back to supervisor',
        );
        await postOpResult(
          cfg,
          stepId,
          popped.opId,
          { ok: false, error: { message } },
          logger,
        );
      }
    }
    logger.info(
      { stepId, reason: isStopped() ? 'stop' : 'idle_timeout' },
      'agent: exiting sandbox-ops loop',
    );
  } finally {
    if (handle) {
      await driver.stop(handle).catch((err: unknown) => {
        logger.warn(
          { stepId, err: err instanceof Error ? err.message : err },
          'agent: failed to stop local sandbox; will leak this handle',
        );
      });
    }
  }
}

async function buildLocalDriver(cfg: AgentConfig): Promise<SandboxDriver> {
  // Reuse the supervisor's driver factory. The agent only supports
  // `process` and `docker` for v1 — k8s / fargate / e2b on the agent
  // side would defeat the purpose (the agent IS the sandbox host).
  if (cfg.driver !== 'process' && cfg.driver !== 'docker') {
    throw new Error(`unsupported agent driver: ${cfg.driver}`);
  }
  return buildSandboxDriverAsync({ mode: cfg.driver });
}

async function executeOp(
  driver: SandboxDriver,
  handle: SandboxHandle | null,
  envelope: OpEnvelope,
  logger: Logger,
): Promise<unknown> {
  const { op, args } = envelope;
  logger.debug({ op, opId: envelope.opId }, 'agent: executing op');

  if (op === 'start') {
    const opts = args as SandboxStartOpts;
    // The supervisor's workspacePath is its own host path; rewrite to
    // an agent-local dir per ADR-0009 (step 4 will land repo bootstrap
    // via driver.exec instead of host-side fs ops). For now the agent
    // creates a fresh dir so driver.start has something to mount.
    const agentLocal = await ensureAgentWorkspace(opts.runId);
    const started = await driver.start({
      ...opts,
      workspacePath: agentLocal,
    });
    return started;
  }

  if (!handle) {
    throw new Error(`op "${op}" requires an active sandbox handle (no prior start)`);
  }

  if (op === 'exec') {
    return driver.exec(handle, args as ExecOpts);
  }
  if (op === 'readFile') {
    const { relPath } = args as { relPath: string };
    const buf = await driver.readFile(handle, relPath);
    return { base64: Buffer.from(buf).toString('base64') };
  }
  if (op === 'writeFile') {
    const { relPath, base64 } = args as { relPath: string; base64: string };
    await driver.writeFile(handle, relPath, Buffer.from(base64, 'base64'));
    return { ok: true };
  }
  if (op === 'kill') {
    const { signal } = (args as { signal?: NodeJS.Signals }) ?? {};
    await driver.kill(handle, signal);
    return { ok: true };
  }
  if (op === 'stop') {
    await driver.stop(handle);
    return { ok: true };
  }
  throw new Error(`unknown sandbox op: ${op}`);
}

async function ensureAgentWorkspace(runId: string): Promise<string> {
  const root = process.env.MERGECREW_AGENT_WORKSPACE_ROOT
    ?? path.join(os.tmpdir(), 'mergecrew-runner-agent');
  const dir = path.join(root, runId);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  return dir;
}

async function pollNextOp(
  cfg: AgentConfig,
  stepId: string,
  logger: Logger,
): Promise<OpEnvelope | null> {
  const url = new URL('/v1/runner-agent/sandbox-ops-poll', cfg.apiUrl).toString();
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${cfg.token}`,
    },
    body: JSON.stringify({ stepId, timeoutSec: SANDBOX_OP_POLL_TIMEOUT_SEC }),
  });
  if (res.status === 401) {
    logger.error('agent: 401 from sandbox-ops-poll — token revoked or unknown.');
    process.exit(4);
  }
  if (!res.ok) {
    logger.warn({ status: res.status, stepId }, 'agent: sandbox-ops-poll unexpected status');
    return null;
  }
  const body = (await res.json()) as PollOpsResponse;
  if (body.kind === 'idle') return null;
  if (!body.opId || !body.op) return null;
  return { opId: body.opId, op: body.op, args: body.args };
}

async function postOpResult(
  cfg: AgentConfig,
  stepId: string,
  opId: string,
  envelope: { ok: boolean; result?: unknown; error?: { message: string; kind?: string } },
  logger: Logger,
): Promise<void> {
  const url = new URL(
    `/v1/runner-agent/sandbox-ops/${encodeURIComponent(stepId)}/${encodeURIComponent(opId)}/result`,
    cfg.apiUrl,
  ).toString();
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${cfg.token}`,
    },
    body: JSON.stringify(envelope),
  });
  if (!res.ok) {
    logger.warn(
      { status: res.status, stepId, opId },
      'agent: failed to post sandbox op result — supervisor will time out',
    );
  }
}
