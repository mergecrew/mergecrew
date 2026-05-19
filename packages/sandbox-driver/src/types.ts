/**
 * Sandbox abstraction over the runner's execution surface. The runner
 * supervisor builds one driver per process (selected via RUNNER_SANDBOX)
 * and calls `start()` at the top of each step, threading the returned
 * handle to skills that exec shell commands.
 *
 * V1 ships two drivers: `process` (today's execa-on-host behavior) and
 * `docker` (per-run container). Later drivers (k8s, fargate, firecracker)
 * plug in at this seam without touching the supervisor or the skill API.
 *
 * See docs/02-architecture/13-runner-isolation.md § 7.
 */
export interface SandboxResources {
  /** Logical CPUs. ProcessDriver records but does not enforce. */
  cpu?: number;
  /** Memory limit in MB. ProcessDriver records but does not enforce. */
  memoryMb?: number;
  /** Max processes (`pids-limit`). ProcessDriver records but does not enforce. */
  pids?: number;
  /** Sandbox-wide wall clock in ms. Hard ceiling on every exec() inside. */
  timeoutMs?: number;
}

export interface SandboxCacheMount {
  /**
   * Host-side directory holding the cache. The supervisor creates it
   * before driver.start() so the mount has something to attach to.
   */
  hostPath: string;
  /**
   * In-container path the host cache mounts to. Caller resolves any
   * `~/` (home) or `./` (workspace-relative) expansion before
   * constructing this opt — the driver mounts verbatim.
   */
  containerPath: string;
}

export interface SandboxStartOpts {
  runId: string;
  projectId: string;
  organizationId: string;
  /**
   * Host-side workspace path that the sandbox mounts as its working
   * directory. The bootstrap (clone) is done by the runner before
   * start() is called.
   */
  workspacePath: string;
  /** OCI image ref. Ignored by ProcessDriver. */
  image?: string;
  resources?: SandboxResources;
  /**
   * Hostname allowlist for outbound traffic. The ProcessDriver does
   * not enforce egress (today's behavior); later drivers apply this
   * at the network namespace.
   */
  egressAllowlist?: string[] | null;
  /**
   * Per-project cache directories that persist across runs (#572).
   * Tagged on the host by (org_id, project_id) so they never cross
   * tenant boundaries. ProcessDriver ignores them (no need — paths
   * are host-local already); DockerDriver mounts each as a --volume.
   */
  cacheMounts?: SandboxCacheMount[];
}

export interface SandboxHandle {
  /** Implementation-defined id. For ProcessDriver, the runId. */
  readonly id: string;
  /** Driver name (`process`, `docker`, …). Useful for telemetry + tests. */
  readonly driver: string;
  /**
   * Where commands run by default. For ProcessDriver this is the host
   * path; for container drivers this is the in-container mount path.
   */
  readonly workspacePath: string;
}

export interface ExecOpts {
  cmd: string;
  args: string[];
  /**
   * Working directory for this exec. Resolved relative to
   * `handle.workspacePath` when not absolute. ProcessDriver allows
   * absolute paths for backwards-compatibility; container drivers
   * will reject paths outside the workspace mount.
   */
  cwd?: string;
  /** Extra env on top of the driver's base. Driver may scrub. */
  env?: Record<string, string>;
  /** Per-call timeout. Driver clamps to sandbox-wide timeout. */
  timeoutMs?: number;
  /** External abort signal; composed with the sandbox's internal signal. */
  signal?: AbortSignal;
}

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** Signal that terminated the process, if any. */
  signal?: string | null;
}

export interface SandboxDriver {
  readonly name: string;
  /**
   * Begin a sandbox. Idempotent for ProcessDriver. For container
   * drivers this pulls/creates the container.
   */
  start(opts: SandboxStartOpts): Promise<SandboxHandle>;
  exec(handle: SandboxHandle, opts: ExecOpts): Promise<ExecResult>;
  /** Read a file relative to the workspace. Rejects path traversal. */
  readFile(handle: SandboxHandle, relPath: string): Promise<Buffer>;
  /** Write a file relative to the workspace. Rejects path traversal. */
  writeFile(handle: SandboxHandle, relPath: string, data: Buffer | string): Promise<void>;
  /** Best-effort kill of any in-flight exec. */
  kill(handle: SandboxHandle, signal?: NodeJS.Signals): Promise<void>;
  /**
   * Terminate the sandbox. Workspace teardown is owned by the runner
   * (the `runner.workspace-cleanup` queue), not the driver — so a
   * crashed supervisor doesn't leak the user's working tree before
   * the orchestrator has read it.
   */
  stop(handle: SandboxHandle): Promise<void>;
}
