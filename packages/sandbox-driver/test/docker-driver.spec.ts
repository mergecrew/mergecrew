import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// Hoisted mock of execa. Each test pushes onto `calls` to assert what
// commands the driver constructed and `responses` to script results.
const execaCalls: { cmd: string; args: string[] }[] = [];
type Response = { exitCode: number; stdout?: string; stderr?: string; timedOut?: boolean; signal?: string | null };
const execaResponses: Response[] = [];
vi.mock('execa', () => ({
  execa: vi.fn(async (cmd: string, args: string[]) => {
    execaCalls.push({ cmd, args });
    const r = execaResponses.shift() ?? { exitCode: 0, stdout: '', stderr: '' };
    return {
      exitCode: r.exitCode,
      stdout: r.stdout ?? '',
      stderr: r.stderr ?? '',
      timedOut: r.timedOut ?? false,
      signal: r.signal ?? null,
      failed: r.exitCode !== 0,
    };
  }),
}));

import { DockerDriver, CONTAINER_WORKSPACE, SANDBOX_UID } from '../src/docker-driver.js';

describe('DockerDriver', () => {
  let workspace: string;
  let driver: DockerDriver;

  beforeEach(async () => {
    workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'docker-driver-test-'));
    driver = new DockerDriver();
    execaCalls.length = 0;
    execaResponses.length = 0;
  });

  afterEach(async () => {
    await fs.rm(workspace, { recursive: true, force: true });
  });

  it('start() runs docker with the hardening flags + workspace mount', async () => {
    execaResponses.push({ exitCode: 0, stdout: 'abc123\n' });
    const handle = await driver.start({
      runId: 'run-1',
      projectId: 'proj-1',
      organizationId: 'org-1',
      workspacePath: workspace,
      image: 'ghcr.io/mergecrew/runner-node:20',
      resources: { cpu: 2, memoryMb: 1024, pids: 256, timeoutMs: 60_000 },
    });
    expect(handle.id).toBe('abc123');
    expect(handle.driver).toBe('docker');
    expect(handle.workspacePath).toBe(CONTAINER_WORKSPACE);

    const args = execaCalls[0]!.args;
    expect(args).toContain('--user');
    expect(args).toContain(`${SANDBOX_UID}:${SANDBOX_UID}`);
    expect(args).toContain('--read-only');
    expect(args).toContain('--network');
    expect(args[args.indexOf('--network') + 1]).toBe('none');
    expect(args).toContain('--cap-drop');
    expect(args).toContain('--security-opt');
    expect(args).toContain('no-new-privileges');
    expect(args).toContain('--cpus');
    expect(args[args.indexOf('--cpus') + 1]).toBe('2');
    expect(args).toContain('--memory');
    expect(args[args.indexOf('--memory') + 1]).toBe('1024m');
    expect(args).toContain('--pids-limit');
    expect(args[args.indexOf('--pids-limit') + 1]).toBe('256');
    expect(args).toContain('--ulimit');
    // Workspace volume mount.
    expect(args).toContain('--volume');
    expect(args[args.indexOf('--volume') + 1]).toBe(`${workspace}:${CONTAINER_WORKSPACE}:rw`);
    // Labels carry the tenant identifiers for telemetry / cleanup sweeps.
    expect(args).toContain('--label');
    expect(args).toContain('mergecrew.runId=run-1');
    expect(args).toContain('mergecrew.projectId=proj-1');
    expect(args).toContain('mergecrew.organizationId=org-1');
    // Image + entrypoint to keep it alive.
    expect(args).toContain('ghcr.io/mergecrew/runner-node:20');
    expect(args.slice(-3)).toEqual(['sh', '-c', 'while true; do sleep 3600; done']);
  });

  it('start() uses the default image when none supplied', async () => {
    execaResponses.push({ exitCode: 0, stdout: 'abc\n' });
    await driver.start({
      runId: 'r',
      projectId: 'p',
      organizationId: 'o',
      workspacePath: workspace,
    });
    const args = execaCalls[0]!.args;
    expect(args).toContain('node:20-bookworm-slim');
  });

  it('joins the configured egress network when egressAllowlist is set', async () => {
    const d = new DockerDriver({ egressNetwork: 'mergecrew-egress' });
    execaResponses.push({ exitCode: 0, stdout: 'abc\n' });
    await d.start({
      runId: 'r',
      projectId: 'p',
      organizationId: 'o',
      workspacePath: workspace,
      egressAllowlist: ['api.github.com'],
    });
    const args = execaCalls[0]!.args;
    expect(args[args.indexOf('--network') + 1]).toBe('mergecrew-egress');
  });

  it('stays on --network none when egressAllowlist is set but no egress network configured', async () => {
    const d = new DockerDriver(); // egressNetwork not set
    execaResponses.push({ exitCode: 0, stdout: 'abc\n' });
    await d.start({
      runId: 'r',
      projectId: 'p',
      organizationId: 'o',
      workspacePath: workspace,
      egressAllowlist: ['api.github.com'],
    });
    const args = execaCalls[0]!.args;
    expect(args[args.indexOf('--network') + 1]).toBe('none');
  });

  it('stays on --network none when egress network is configured but allowlist is empty', async () => {
    const d = new DockerDriver({ egressNetwork: 'mergecrew-egress' });
    execaResponses.push({ exitCode: 0, stdout: 'abc\n' });
    await d.start({
      runId: 'r',
      projectId: 'p',
      organizationId: 'o',
      workspacePath: workspace,
      egressAllowlist: [],
    });
    const args = execaCalls[0]!.args;
    expect(args[args.indexOf('--network') + 1]).toBe('none');
  });

  it('start() passes --runtime when ociRuntime is configured', async () => {
    const d = new DockerDriver({ ociRuntime: 'runsc' });
    execaResponses.push({ exitCode: 0, stdout: 'abc\n' });
    await d.start({ runId: 'r', projectId: 'p', organizationId: 'o', workspacePath: workspace });
    const args = execaCalls[0]!.args;
    expect(args).toContain('--runtime');
    expect(args[args.indexOf('--runtime') + 1]).toBe('runsc');
  });

  it('start() throws when docker run fails', async () => {
    execaResponses.push({ exitCode: 125, stderr: 'pull access denied' });
    await expect(
      driver.start({ runId: 'r', projectId: 'p', organizationId: 'o', workspacePath: workspace }),
    ).rejects.toThrow(/docker run failed/);
  });

  it('start() throws when workspacePath does not exist', async () => {
    await expect(
      driver.start({
        runId: 'r',
        projectId: 'p',
        organizationId: 'o',
        workspacePath: path.join(workspace, 'missing'),
      }),
    ).rejects.toThrow(/does not exist/);
  });

  it('exec() builds docker exec with the in-container working dir', async () => {
    execaResponses.push({ exitCode: 0, stdout: 'cid\n' }); // start
    const handle = await driver.start({
      runId: 'r',
      projectId: 'p',
      organizationId: 'o',
      workspacePath: workspace,
    });
    execaCalls.length = 0;
    execaResponses.push({ exitCode: 0, stdout: 'hello' });

    const r = await driver.exec(handle, { cmd: 'echo', args: ['hello'], cwd: 'sub' });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe('hello');

    const args = execaCalls[0]!.args;
    expect(args[0]).toBe('exec');
    expect(args).toContain('--workdir');
    expect(args[args.indexOf('--workdir') + 1]).toBe(`${CONTAINER_WORKSPACE}/sub`);
    expect(args).toContain('cid');
    expect(args).toContain('echo');
    expect(args).toContain('hello');
  });

  it('exec() forwards env via -e KEY=VAL', async () => {
    execaResponses.push({ exitCode: 0, stdout: 'cid\n' });
    const handle = await driver.start({
      runId: 'r',
      projectId: 'p',
      organizationId: 'o',
      workspacePath: workspace,
    });
    execaCalls.length = 0;
    execaResponses.push({ exitCode: 0, stdout: '' });

    await driver.exec(handle, { cmd: 'true', args: [], env: { CI: '1', NODE_ENV: 'test' } });
    const args = execaCalls[0]!.args;
    const envFlags: string[] = [];
    for (let i = 0; i < args.length - 1; i++) {
      if (args[i] === '-e') envFlags.push(args[i + 1]!);
    }
    expect(envFlags).toContain('CI=1');
    expect(envFlags).toContain('NODE_ENV=test');
  });

  it('kill() invokes docker kill', async () => {
    execaResponses.push({ exitCode: 0, stdout: 'cid\n' });
    const handle = await driver.start({
      runId: 'r',
      projectId: 'p',
      organizationId: 'o',
      workspacePath: workspace,
    });
    execaCalls.length = 0;
    execaResponses.push({ exitCode: 0, stdout: '' });
    await driver.kill(handle);
    expect(execaCalls[0]!).toEqual({ cmd: 'docker', args: ['kill', 'cid'] });
  });

  it('stop() invokes docker rm -f and forgets the workspace mapping', async () => {
    execaResponses.push({ exitCode: 0, stdout: 'cid\n' });
    const handle = await driver.start({
      runId: 'r',
      projectId: 'p',
      organizationId: 'o',
      workspacePath: workspace,
    });
    execaCalls.length = 0;
    execaResponses.push({ exitCode: 0, stdout: '' });
    await driver.stop(handle);
    expect(execaCalls[0]!).toEqual({ cmd: 'docker', args: ['rm', '-f', 'cid'] });

    // After stop(), the file-bridge map is cleared, so subsequent file ops
    // fail rather than silently reading from a stale path.
    await expect(driver.readFile(handle, 'x')).rejects.toThrow(/unknown sandbox handle/);
  });

  it('readFile / writeFile round-trip via the host bind mount', async () => {
    execaResponses.push({ exitCode: 0, stdout: 'cid\n' });
    const handle = await driver.start({
      runId: 'r',
      projectId: 'p',
      organizationId: 'o',
      workspacePath: workspace,
    });
    await driver.writeFile(handle, 'a/b.txt', 'payload');
    const buf = await driver.readFile(handle, 'a/b.txt');
    expect(buf.toString()).toBe('payload');
  });

  it('readFile rejects absolute paths and traversal', async () => {
    execaResponses.push({ exitCode: 0, stdout: 'cid\n' });
    const handle = await driver.start({
      runId: 'r',
      projectId: 'p',
      organizationId: 'o',
      workspacePath: workspace,
    });
    await expect(driver.readFile(handle, '/etc/passwd')).rejects.toThrow(/absolute paths/);
    await expect(driver.readFile(handle, '../escape')).rejects.toThrow(/escapes the sandbox/);
  });

  it('respects a custom docker bin (for podman compat)', async () => {
    const d = new DockerDriver({ dockerBin: 'podman' });
    execaResponses.push({ exitCode: 0, stdout: 'cid\n' });
    await d.start({ runId: 'r', projectId: 'p', organizationId: 'o', workspacePath: workspace });
    expect(execaCalls[0]!.cmd).toBe('podman');
  });
});
