import path from 'node:path';
import { promises as fs } from 'node:fs';
import { execa } from 'execa';
import type {
  ExecOpts,
  ExecResult,
  SandboxDriver,
  SandboxHandle,
  SandboxStartOpts,
} from './types.js';
import { buildScrubbedEnv, classifySensitiveKey } from './env.js';

export interface ProcessDriverOpts {
  logger?: {
    info: (msg: string, meta?: any) => void;
    warn: (msg: string, meta?: any) => void;
    error: (msg: string, meta?: any) => void;
  };
}

/**
 * The shipping-as-of-V0 execution model: spawn subprocesses directly
 * on the runner host. No filesystem namespace, no network namespace,
 * no resource caps beyond the per-exec timeout. Identical observable
 * behavior to today's `execa` calls in `packages/skills/src/stock/*.ts`
 * so that flipping `RUNNER_SANDBOX=process` (the default) is a no-op.
 *
 * Use this driver only when the runner host is single-tenant or
 * disposable; multi-tenant production should use `docker` (#557).
 */
export class ProcessDriver implements SandboxDriver {
  readonly name = 'process';
  private readonly logger?: ProcessDriverOpts['logger'];

  constructor(opts: ProcessDriverOpts = {}) {
    this.logger = opts.logger;
  }

  async start(opts: SandboxStartOpts): Promise<SandboxHandle> {
    // Validate workspace exists; everything else is a no-op for this driver.
    const stat = await fs.stat(opts.workspacePath).catch(() => null);
    if (!stat || !stat.isDirectory()) {
      throw new Error(`workspacePath does not exist or is not a directory: ${opts.workspacePath}`);
    }
    return {
      id: opts.runId,
      driver: this.name,
      workspacePath: opts.workspacePath,
    };
  }

  async exec(handle: SandboxHandle, opts: ExecOpts): Promise<ExecResult> {
    const cwd = resolveCwd(handle.workspacePath, opts.cwd);
    // Env scrub (#561). Start from the allowlisted base — never the
    // full process.env — and let the caller layer on explicit values.
    // Per-call sensitive overrides are honored (the supervisor sometimes
    // legitimately injects a scoped secret) but logged so the leak path
    // is visible in operator telemetry.
    const base = buildScrubbedEnv();
    if (opts.env && this.logger) {
      for (const key of Object.keys(opts.env)) {
        const prefix = classifySensitiveKey(key);
        if (prefix) {
          this.logger.warn(
            'sandbox env contains a sensitive prefix — verify this is project-scoped, not supervisor-scope',
            { key, prefix, sandbox: handle.id },
          );
        }
      }
    }
    const env: Record<string, string> = opts.env ? { ...base, ...opts.env } : base;
    const r = await execa(opts.cmd, opts.args, {
      cwd,
      env,
      // CRUCIAL: execa merges `env` with process.env by default; without
      // this the scrub above is a no-op. extendEnv: false hands the
      // child *only* what we built.
      extendEnv: false,
      signal: opts.signal,
      timeout: opts.timeoutMs ?? 0,
      reject: false,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    return {
      exitCode: r.exitCode ?? (r.failed ? 1 : 0),
      stdout: typeof r.stdout === 'string' ? r.stdout : '',
      stderr: typeof r.stderr === 'string' ? r.stderr : '',
      timedOut: Boolean(r.timedOut),
      signal: r.signal ?? null,
    };
  }

  async readFile(handle: SandboxHandle, relPath: string): Promise<Buffer> {
    const abs = resolveInside(handle.workspacePath, relPath);
    return fs.readFile(abs);
  }

  async writeFile(handle: SandboxHandle, relPath: string, data: Buffer | string): Promise<void> {
    const abs = resolveInside(handle.workspacePath, relPath);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, data);
  }

  async kill(_handle: SandboxHandle, _signal?: NodeJS.Signals): Promise<void> {
    // ProcessDriver tracks no long-lived state; per-exec abort signals
    // are how callers cancel work. This is a no-op so the interface
    // is uniform across drivers.
  }

  async stop(_handle: SandboxHandle): Promise<void> {
    // No-op — see kill().
  }
}

function resolveCwd(workspace: string, cwd: string | undefined): string {
  if (!cwd) return workspace;
  return path.isAbsolute(cwd) ? cwd : path.resolve(workspace, cwd);
}

/**
 * Reject path traversal even though ProcessDriver shares the host
 * filesystem with everything else — this is the foundation that
 * `skills/src/workspace.ts` (#580) will lean on.
 */
function resolveInside(workspace: string, relPath: string): string {
  if (path.isAbsolute(relPath)) {
    throw new Error(`absolute paths are not allowed in sandbox file I/O: ${relPath}`);
  }
  const abs = path.resolve(workspace, relPath);
  const rel = path.relative(workspace, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`path escapes the sandbox workspace: ${relPath}`);
  }
  return abs;
}
