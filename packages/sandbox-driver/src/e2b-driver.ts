/**
 * E2B (Firecracker microVM) sandbox driver (#579).
 *
 * Backed by the open-source E2B infra (https://github.com/e2b-dev/infra).
 * Operators self-host the E2B control plane and point this driver at
 * it; we never embed a hosted E2B API key in the default config. See
 * docs/02-architecture/14-runner-microvm-decision.md for the rationale.
 *
 * Lifecycle:
 *
 *   start()  → Sandbox.create({ template, metadata, envs, … })
 *              Snapshot restore is sub-second on warm templates; first
 *              build is 10–30s while the template caches.
 *   exec()   → sandbox.commands.run(<sh -c …>) — streams stdout/stderr.
 *   readFile → sandbox.files.read(target)
 *   writeFile → sandbox.files.write(target, data)
 *   kill/stop → sandbox.kill()
 *
 * The SandboxDriver contract is satisfied by wrapping each call in the
 * `E2BApiClient` seam so the driver is unit-testable against an in-
 * memory fake.
 */

import type {
  ExecOpts,
  ExecResult,
  SandboxDriver,
  SandboxHandle,
  SandboxStartOpts,
} from './types.js';
import { CONTAINER_WORKSPACE } from './docker-driver-constants.js';

export interface E2BApiClient {
  /**
   * Create a sandbox from a template. Returns the sandbox id (which
   * becomes the SandboxHandle id). Should call into E2B's
   * `Sandbox.create()`.
   */
  createSandbox(opts: E2BCreateOpts): Promise<string>;
  /**
   * Run a command inside the sandbox. The driver wraps cwd + env into
   * a single `sh -c '…'` argv so the underlying SDK doesn't need to
   * model them separately.
   */
  runCommand(
    sandboxId: string,
    cmd: string[],
    opts: { stdin?: Buffer | string; timeoutMs?: number; signal?: AbortSignal },
  ): Promise<{ exitCode: number; stdout: string; stderr: string; timedOut: boolean }>;
  /** Read a file at the absolute path. */
  readFile(sandboxId: string, path: string): Promise<Buffer>;
  /** Write a file at the absolute path. Creates parent dirs. */
  writeFile(sandboxId: string, path: string, data: Buffer | string): Promise<void>;
  /** Kill the sandbox. Idempotent on already-killed sandboxes. */
  killSandbox(sandboxId: string): Promise<void>;
}

export interface E2BCreateOpts {
  /**
   * E2B template id (or alias). Operators define one per stack — node,
   * python, polyglot — and pass them in here. Default templates live
   * in infra/e2b/templates/ once self-hosted.
   */
  template: string;
  metadata: Record<string, string>;
  envs: Record<string, string>;
  /** Sandbox-wide lifetime ceiling. Mapped to E2B's timeoutMs. */
  timeoutMs?: number;
}

export interface E2BDriverOpts {
  api: E2BApiClient;
  /**
   * Default template when SandboxStartOpts.image is empty. Format is an
   * E2B template id, NOT an OCI image — the operator builds templates
   * from base images via `e2b template build`. See docs/03-infrastructure/
   * 32-runner-e2b.md.
   */
  defaultTemplate?: string;
  /**
   * SLA target for cold start. Used to emit a regression metric — the
   * driver doesn't enforce it. Default 5000ms per #579 acceptance.
   */
  coldStartTargetMs?: number;
  logger?: {
    info: (m: string, meta?: any) => void;
    warn: (m: string, meta?: any) => void;
    error: (m: string, meta?: any) => void;
    metric?: (name: string, value: number, tags?: Record<string, string>) => void;
  };
}

interface SandboxRecord {
  sandboxId: string;
  startedAt: number;
}

export class E2BDriver implements SandboxDriver {
  readonly name = 'e2b';
  private readonly api: E2BApiClient;
  private readonly defaultTemplate: string;
  private readonly coldStartTargetMs: number;
  private readonly logger?: E2BDriverOpts['logger'];

  private readonly records = new Map<string, SandboxRecord>();

  constructor(opts: E2BDriverOpts) {
    this.api = opts.api;
    this.defaultTemplate = opts.defaultTemplate ?? 'mergecrew-polyglot';
    this.coldStartTargetMs = opts.coldStartTargetMs ?? 5_000;
    this.logger = opts.logger;
  }

  async start(opts: SandboxStartOpts): Promise<SandboxHandle> {
    const template = opts.image ?? this.defaultTemplate;
    const startedAt = Date.now();
    const sandboxId = await this.api.createSandbox({
      template,
      metadata: {
        'mergecrew.run-id': opts.runId,
        'mergecrew.project-id': opts.projectId,
        'mergecrew.organization-id': opts.organizationId,
      },
      envs: {},
      timeoutMs: opts.resources?.timeoutMs,
    });
    const coldStartMs = Date.now() - startedAt;
    this.logger?.metric?.('e2b.cold_start_ms', coldStartMs, { runId: opts.runId });
    if (coldStartMs > this.coldStartTargetMs) {
      this.logger?.warn(
        `e2b cold start ${coldStartMs}ms exceeded ${this.coldStartTargetMs}ms target — likely a fresh template build`,
        { runId: opts.runId, sandboxId },
      );
    }
    this.logger?.info('e2b sandbox started', {
      runId: opts.runId,
      sandboxId,
      template,
      coldStartMs,
    });
    this.records.set(sandboxId, { sandboxId, startedAt });
    return { id: sandboxId, driver: this.name, workspacePath: CONTAINER_WORKSPACE };
  }

  async exec(handle: SandboxHandle, opts: ExecOpts): Promise<ExecResult> {
    if (!this.records.has(handle.id)) {
      throw new Error(`unknown e2b sandbox handle: ${handle.id}`);
    }
    const cwd = opts.cwd ? this.resolveContainerPath(opts.cwd) : CONTAINER_WORKSPACE;
    const envExports = Object.entries(opts.env ?? {})
      .map(([k, v]) => `export ${k}=${shellEscape(v)};`)
      .join(' ');
    const cmdLine = [opts.cmd, ...opts.args].map(shellEscape).join(' ');
    const wrapped = ['sh', '-c', `cd ${shellEscape(cwd)} && ${envExports} ${cmdLine}`.trim()];
    const r = await this.api.runCommand(handle.id, wrapped, {
      timeoutMs: opts.timeoutMs,
      signal: opts.signal,
    });
    return {
      exitCode: r.exitCode,
      stdout: r.stdout,
      stderr: r.stderr,
      timedOut: r.timedOut,
      signal: null,
    };
  }

  async readFile(handle: SandboxHandle, relPath: string): Promise<Buffer> {
    if (!this.records.has(handle.id)) {
      throw new Error(`unknown e2b sandbox handle: ${handle.id}`);
    }
    return this.api.readFile(handle.id, this.resolveContainerPath(relPath));
  }

  async writeFile(handle: SandboxHandle, relPath: string, data: Buffer | string): Promise<void> {
    if (!this.records.has(handle.id)) {
      throw new Error(`unknown e2b sandbox handle: ${handle.id}`);
    }
    await this.api.writeFile(handle.id, this.resolveContainerPath(relPath), data);
  }

  async kill(handle: SandboxHandle, _signal?: NodeJS.Signals): Promise<void> {
    if (!this.records.has(handle.id)) return;
    await this.api.killSandbox(handle.id).catch(() => {});
  }

  async stop(handle: SandboxHandle): Promise<void> {
    if (!this.records.has(handle.id)) return;
    await this.api.killSandbox(handle.id).catch(() => {});
    this.records.delete(handle.id);
  }

  private resolveContainerPath(rel: string): string {
    if (rel.startsWith('/')) {
      if (!rel.startsWith(CONTAINER_WORKSPACE + '/') && rel !== CONTAINER_WORKSPACE) {
        throw new Error(`absolute paths must live under ${CONTAINER_WORKSPACE}: ${rel}`);
      }
      return rel;
    }
    return `${CONTAINER_WORKSPACE}/${rel}`;
  }
}

function shellEscape(s: string): string {
  if (s === '') return "''";
  if (/^[A-Za-z0-9_\-.\/:=]+$/.test(s)) return s;
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
