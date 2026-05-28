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
  /**
   * Docker network the sandbox joins when an egress allowlist is
   * present (#573). The default `none` keeps containers offline;
   * operators provision a `mergecrew-egress` network with nftables
   * rules that ACCEPT traffic to allowlisted IPs and DROP everything
   * else (see docs/03-infrastructure/23-runner-network-policy.md).
   * Operators set this via RUNNER_EGRESS_NETWORK without touching code.
   */
  egressNetwork?: string;
  /**
   * IPv4 of the per-run DNS resolver (#574). When set, the sandbox
   * launches with `--dns <ip>` so its `/etc/resolv.conf` points at the
   * resolver instead of the host's default. The resolver returns
   * NXDOMAIN for hostnames outside the project's allowlist — closes
   * the "resolve `pypi.evil.com` then connect by IP" hole that
   * nftables (#573) can't see by name. Operators set via
   * RUNNER_DNS_RESOLVER.
   */
  dnsResolver?: string;
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
  private readonly egressNetwork: string | undefined;
  private readonly dnsResolver: string | undefined;
  private readonly logger?: DockerDriverOpts['logger'];

  // Map containerId → host workspace path for fs-bridge ops.
  private readonly workspaces = new Map<string, string>();

  constructor(opts: DockerDriverOpts = {}) {
    this.defaultImage = opts.defaultImage ?? 'node:20-bookworm-slim';
    this.ociRuntime = opts.ociRuntime;
    this.bin = opts.dockerBin ?? 'docker';
    this.egressNetwork = opts.egressNetwork;
    this.dnsResolver = opts.dnsResolver;
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

    // Cold-start timer (#565 dogfood gate). The bake-report aggregates
    // these per-day to compare process vs docker driver latency
    // overhead. We measure `docker run` only — chown is bounded by
    // workspace size and gets its own warning when slow.
    const startedAt = Date.now();
    const result = await execa(this.bin, args, { reject: false });
    const durationMs = Date.now() - startedAt;
    if (result.exitCode !== 0) {
      throw new Error(
        `docker run failed (exit ${result.exitCode}): ${(result.stderr ?? '').toString().trim()}`,
      );
    }
    const containerId = result.stdout.toString().trim();
    this.workspaces.set(containerId, opts.workspacePath);
    this.logger?.info('sandbox started', {
      event: 'sandbox.cold_start',
      driver: 'docker',
      runId: opts.runId,
      projectId: opts.projectId,
      organizationId: opts.organizationId,
      containerId,
      image,
      ociRuntime: this.ociRuntime,
      durationMs,
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
    const exitCode = result.exitCode ?? (result.failed ? 1 : 0);
    // OOM detection (#565 dogfood gate). Exit code 137 = SIGKILL,
    // which on a cgroup-limited container almost always means the
    // kernel OOM-killer hit a memory budget. Confirm via `docker
    // inspect` when we can — operators want to distinguish "your
    // build OOM'd" from "we sent SIGKILL on timeout" because they
    // demand different remediations (raise --memory vs. raise
    // --timeout). Inspect is best-effort: if it fails or the
    // container is already gone, the suspect signal is still
    // useful, so emit it either way.
    if (exitCode === 137) {
      let containerOomKilled: boolean | null = null;
      try {
        const inspect = await execa(
          this.bin,
          ['inspect', '--format', '{{.State.OOMKilled}}', handle.id],
          { reject: false },
        );
        const raw = (typeof inspect.stdout === 'string' ? inspect.stdout : '').trim();
        if (raw === 'true') containerOomKilled = true;
        else if (raw === 'false') containerOomKilled = false;
      } catch {
        // Inspect failed (container already removed, daemon hiccup) —
        // suspect signal is the best we can do; report as null.
      }
      this.logger?.warn('sandbox OOM suspected', {
        event: 'sandbox.oom_suspected',
        driver: 'docker',
        containerId: handle.id,
        exitCode,
        containerOomKilled,
        cmd: opts.cmd,
      });
    }
    return {
      exitCode,
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

  /**
   * Remove sandbox containers left behind by a previous supervisor
   * process — OOM, kernel panic, `docker compose down` while a step
   * was in flight (#831). Without this, crash-loops accumulate dead
   * `mergecrew-*` containers and image-layer disk usage.
   *
   * Best-effort: every individual `docker rm -f` failure is warn-logged
   * and skipped; the sweep itself never throws. Capped at `maxRemovals`
   * so a pathological pileup can't block startup.
   *
   * Called once from the runner's main.ts after the driver promise
   * resolves and before the BullMQ worker starts consuming.
   */
  async purgeOrphans(opts: {
    maxAgeMs?: number;
    maxRemovals?: number;
    now?: () => number;
  } = {}): Promise<{ candidates: number; removed: number; skippedRecent: number }> {
    const maxAgeMs = opts.maxAgeMs ?? 60 * 60 * 1000;
    const maxRemovals = opts.maxRemovals ?? 100;
    const now = opts.now ?? (() => Date.now());

    const listResult = await execa(
      this.bin,
      [
        'ps',
        '-a',
        '--filter',
        'name=^/mergecrew-',
        '--filter',
        'status=exited',
        '--filter',
        'status=created',
        '--format',
        '{{.Names}}\t{{.FinishedAt}}\t{{.State}}',
      ],
      { reject: false },
    );
    if (listResult.exitCode !== 0) {
      this.logger?.warn('orphan sweep: docker ps -a failed; skipping', {
        event: 'runner.orphan_sweep_failed',
        stderr: (listResult.stderr ?? '').toString().trim(),
      });
      return { candidates: 0, removed: 0, skippedRecent: 0 };
    }
    const raw = listResult.stdout.toString().trim();
    if (!raw) return { candidates: 0, removed: 0, skippedRecent: 0 };

    const rows = raw.split('\n').map((line) => {
      const [name, finishedAt, state] = line.split('\t');
      return { name: name ?? '', finishedAt: finishedAt ?? '', state: state ?? '' };
    });

    const eligible: string[] = [];
    let skippedRecent = 0;
    for (const row of rows) {
      if (!row.name.startsWith('mergecrew-')) continue;
      // `created` containers never started; treat as orphan unconditionally.
      // `exited` containers compared against maxAgeMs.
      if (row.state === 'created') {
        eligible.push(row.name);
        continue;
      }
      if (row.state !== 'exited') continue;
      const ts = Date.parse(row.finishedAt);
      if (!Number.isFinite(ts) || now() - ts > maxAgeMs) {
        eligible.push(row.name);
      } else {
        skippedRecent += 1;
      }
    }

    const toRemove = eligible.slice(0, maxRemovals);
    let removed = 0;
    for (const name of toRemove) {
      const rm = await execa(this.bin, ['rm', '-f', name], { reject: false });
      if (rm.exitCode === 0) {
        removed += 1;
      } else {
        this.logger?.warn('orphan sweep: docker rm -f failed', {
          event: 'runner.orphan_rm_failed',
          name,
          stderr: (rm.stderr ?? '').toString().trim(),
        });
      }
    }
    this.logger?.info('orphan sweep complete', {
      event: 'runner.orphan_sweep',
      candidates: eligible.length,
      removed,
      skippedRecent,
      cappedAt: toRemove.length < eligible.length ? maxRemovals : undefined,
    });
    return { candidates: eligible.length, removed, skippedRecent };
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
    // Egress posture (#573). Default-deny is the safe baseline:
    // `--network none` means no outbound at all. When the project
    // sets `runner.egress.allow`, the supervisor flips us to the
    // operator-provisioned egress network whose nftables ruleset
    // accepts traffic to the allowlisted IPs and drops the rest.
    // Without an operator-provisioned network the runner stays in
    // `none` mode even when an allowlist is present — better safe
    // (no outbound) than sorry (full outbound).
    const wantsAllowlistedEgress = (opts.egressAllowlist?.length ?? 0) > 0;
    if (wantsAllowlistedEgress && this.egressNetwork) {
      args.push('--network', this.egressNetwork);
      // Point /etc/resolv.conf at the runner-dns resolver (#574) so
      // hostname-based exfiltration is blocked at the DNS layer in
      // addition to the IP layer (nftables, #573).
      if (this.dnsResolver) {
        args.push('--dns', this.dnsResolver);
      }
    } else {
      args.push('--network', 'none');
    }
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
