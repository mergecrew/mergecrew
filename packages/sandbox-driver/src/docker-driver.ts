import { execa, type ExecaChildProcess } from 'execa';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { promises as fs } from 'node:fs';

import type {
  ExecOpts,
  ExecResult,
  SandboxDriver,
  SandboxHandle,
  SandboxStartOpts,
} from './types.js';
import { classifySensitiveKey } from './env.js';
import { chownWorkspaceForSandbox } from './workspace-prep.js';

export { CONTAINER_WORKSPACE, SANDBOX_UID, SANDBOX_GID } from './docker-driver-constants.js';
import { CONTAINER_WORKSPACE, SANDBOX_UID, SANDBOX_GID } from './docker-driver-constants.js';

export interface DockerDriverOpts {
  /** Image used when `SandboxStartOpts.image` is empty. */
  defaultImage?: string;
  /**
   * OCI runtime: `runc` (default), `runsc` (gVisor), `sysbox-runc`, etc.
   * Operators set this via RUNNER_OCI_RUNTIME without touching code.
   */
  ociRuntime?: string;
  /** Path to the docker (or podman) CLI. */
  dockerBin?: string;
  logger?: {
    info: (m: string, meta?: any) => void;
    warn: (m: string, meta?: any) => void;
    error: (m: string, meta?: any) => void;
  };
}

/**
 * Per-run OCI container driver. Each `start()` launches a long-running
 * sleeper container (`sh -c 'while true; do sleep 3600; done'`) into
 * which subsequent `exec()` calls `docker exec`. `stop()` removes it.
 *
 * Container hardening (#557):
 *   --user 1001:1001
 *   --read-only + tmpfs for /tmp and /home/mergecrew
 *   --network none           (egress allowlist is layered on later
 *                             phases — base policy is deny-everything)
 *   --cap-drop ALL
 *   --security-opt no-new-privileges
 *   --pids-limit / --memory / --cpus from SandboxStartOpts.resources
 *
 * Filesystem I/O uses the host-side mount path (same approach as
 * ProcessDriver) — the bind mount makes the container's `/workspace`
 * the same bytes as the host workspace dir, so we don't need `docker
 * cp` for skill-level reads/writes.
 */
export class DockerDriver implements SandboxDriver {
  readonly name = 'docker';
  private readonly defaultImage: string;
  private readonly ociRuntime: string | undefined;
  private readonly bin: string;
  private readonly logger?: DockerDriverOpts['logger'];

  // Map containerId → host workspace path for fs-bridge ops.
  private readonly workspaces = new Map<string, string>();

  constructor(opts: DockerDriverOpts = {}) {
    this.defaultImage = opts.defaultImage ?? 'node:20-bookworm-slim';
    this.ociRuntime = opts.ociRuntime;
    this.bin = opts.dockerBin ?? 'docker';
    this.logger = opts.logger;
  }

  async start(opts: SandboxStartOpts): Promise<SandboxHandle> {
    const stat = await fs.stat(opts.workspacePath).catch(() => null);
    if (!stat || !stat.isDirectory()) {
      throw new Error(`workspacePath does not exist: ${opts.workspacePath}`);
    }
    // Threat T-2 (#554): the sandbox process runs as uid 1001 (set
    // below via --user). The bind-mounted workspace must be owned by
    // uid 1001 for that process to read+write it. Best-effort recursive
    // chown — fails closed with a clear warning when the supervisor
    // lacks CAP_CHOWN (e.g. unprivileged systemd unit) so operators
    // can debug without staring at opaque EACCES errors inside the
    // container. See docs/03-infrastructure/22-runner-images.md.
    await chownWorkspaceForSandbox(opts.workspacePath, this.logger).catch(() => {});
    const image = opts.image ?? this.defaultImage;
    const name = `mergecrew-${opts.runId}-${randomUUID().slice(0, 8)}`;
    const args = this.buildRunArgs(name, image, opts);

    const result = await execa(this.bin, args, { reject: false });
    if (result.exitCode !== 0) {
      throw new Error(
        `docker run failed (exit ${result.exitCode}): ${(result.stderr ?? '').toString().trim()}`,
      );
    }
    const containerId = result.stdout.toString().trim();
    this.workspaces.set(containerId, opts.workspacePath);
    this.logger?.info('sandbox started', {
      runId: opts.runId,
      containerId,
      image,
      ociRuntime: this.ociRuntime,
    });

    return {
      id: containerId,
      driver: this.name,
      workspacePath: CONTAINER_WORKSPACE,
    };
  }

  async exec(handle: SandboxHandle, opts: ExecOpts): Promise<ExecResult> {
    const args = ['exec'];
    if (opts.env) {
      // docker exec doesn't inherit the supervisor process.env (it
      // starts from the container's image-supplied env), so the env
      // scrub (#561) is structural here. We still warn when a caller
      // explicitly passes a sensitive-prefix key — the supervisor
      // might be doing it intentionally, but it should be visible.
      for (const [k, v] of Object.entries(opts.env)) {
        const prefix = classifySensitiveKey(k);
        if (prefix) {
          this.logger?.warn(
            'sandbox env contains a sensitive prefix — verify this is project-scoped, not supervisor-scope',
            { key: k, prefix, sandbox: handle.id },
          );
        }
        args.push('-e', `${k}=${v}`);
      }
    }
    if (opts.cwd) {
      const cwd = path.posix.isAbsolute(opts.cwd)
        ? opts.cwd
        : path.posix.join(CONTAINER_WORKSPACE, opts.cwd);
      args.push('--workdir', cwd);
    }
    args.push(handle.id, opts.cmd, ...opts.args);

    let child: ExecaChildProcess | undefined;
    const result = await execa(this.bin, args, {
      reject: false,
      timeout: opts.timeoutMs ?? 0,
      signal: opts.signal,
      stdout: 'pipe',
      stderr: 'pipe',
    }).catch((err: any) => {
      // execa throws on signal/timeout when `reject: true`. With reject:false
      // it returns the result instead, but be defensive in case the docker
      // CLI itself fails to launch.
      return {
        exitCode: 1,
        stdout: '',
        stderr: String(err?.message ?? err),
        timedOut: false,
        signal: null,
        failed: true,
      } as any;
    });
    void child;
    return {
      exitCode: result.exitCode ?? (result.failed ? 1 : 0),
      stdout: typeof result.stdout === 'string' ? result.stdout : '',
      stderr: typeof result.stderr === 'string' ? result.stderr : '',
      timedOut: Boolean((result as any).timedOut),
      signal: (result as any).signal ?? null,
    };
  }

  async readFile(handle: SandboxHandle, relPath: string): Promise<Buffer> {
    return fs.readFile(this.resolveHost(handle, relPath));
  }

  async writeFile(handle: SandboxHandle, relPath: string, data: Buffer | string): Promise<void> {
    const host = this.resolveHost(handle, relPath);
    await fs.mkdir(path.dirname(host), { recursive: true });
    await fs.writeFile(host, data);
  }

  async kill(handle: SandboxHandle, _signal?: NodeJS.Signals): Promise<void> {
    await execa(this.bin, ['kill', handle.id], { reject: false });
  }

  async stop(handle: SandboxHandle): Promise<void> {
    await execa(this.bin, ['rm', '-f', handle.id], { reject: false });
    this.workspaces.delete(handle.id);
  }

  /** Exposed for tests. */
  buildRunArgs(name: string, image: string, opts: SandboxStartOpts): string[] {
    const args = ['run', '-d', '--name', name];

    args.push('--user', `${SANDBOX_UID}:${SANDBOX_GID}`);
    args.push('--read-only');
    args.push('--tmpfs', '/tmp:rw,size=512m,mode=1777');
    args.push('--tmpfs', `/home/mergecrew:rw,size=512m,uid=${SANDBOX_UID},gid=${SANDBOX_GID}`);
    args.push('--volume', `${opts.workspacePath}:${CONTAINER_WORKSPACE}:rw`);
    // Per-project cache mounts (#572). Listed after the workspace so a
    // misconfigured cache.paths can't shadow `/workspace`.
    for (const cache of opts.cacheMounts ?? []) {
      args.push('--volume', `${cache.hostPath}:${cache.containerPath}:rw`);
    }
    args.push('--workdir', CONTAINER_WORKSPACE);
    args.push('--network', 'none');
    args.push('--cap-drop', 'ALL');
    args.push('--security-opt', 'no-new-privileges');
    args.push('--label', `mergecrew.runId=${opts.runId}`);
    args.push('--label', `mergecrew.projectId=${opts.projectId}`);
    args.push('--label', `mergecrew.organizationId=${opts.organizationId}`);

    const r = opts.resources ?? {};
    if (r.cpu != null) args.push('--cpus', String(r.cpu));
    if (r.memoryMb != null) args.push('--memory', `${r.memoryMb}m`);
    if (r.pids != null) args.push('--pids-limit', String(r.pids));
    args.push('--ulimit', 'nofile=1024:1024');

    if (this.ociRuntime) args.push('--runtime', this.ociRuntime);

    args.push(image);
    // Keep the container alive between exec calls. Stock images run as the
    // mergecrew user, so the sleep loop runs unprivileged.
    args.push('sh', '-c', 'while true; do sleep 3600; done');
    return args;
  }

  private resolveHost(handle: SandboxHandle, relPath: string): string {
    const host = this.workspaces.get(handle.id);
    if (!host) throw new Error(`unknown sandbox handle: ${handle.id}`);
    if (path.isAbsolute(relPath)) {
      throw new Error(`absolute paths are not allowed in sandbox file I/O: ${relPath}`);
    }
    const abs = path.resolve(host, relPath);
    const rel = path.relative(host, abs);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      throw new Error(`path escapes the sandbox workspace: ${relPath}`);
    }
    return abs;
  }
}
