import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ProcessDriver } from '../src/process-driver.js';
import { buildSandboxDriver } from '../src/factory.js';

describe('ProcessDriver', () => {
  let workspace: string;
  let driver: ProcessDriver;

  beforeEach(async () => {
    workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'sandbox-test-'));
    driver = new ProcessDriver();
  });

  afterEach(async () => {
    await fs.rm(workspace, { recursive: true, force: true });
  });

  it('rejects start() when workspace does not exist', async () => {
    await expect(
      driver.start({
        runId: 'r1',
        projectId: 'p1',
        organizationId: 'o1',
        workspacePath: path.join(workspace, 'does-not-exist'),
      }),
    ).rejects.toThrow(/does not exist/);
  });

  it('start() returns a handle scoped to the workspace', async () => {
    const handle = await driver.start({
      runId: 'r1',
      projectId: 'p1',
      organizationId: 'o1',
      workspacePath: workspace,
    });
    expect(handle.driver).toBe('process');
    expect(handle.id).toBe('r1');
    expect(handle.workspacePath).toBe(workspace);
  });

  it('exec() runs in the workspace cwd by default', async () => {
    const handle = await driver.start({
      runId: 'r1',
      projectId: 'p1',
      organizationId: 'o1',
      workspacePath: workspace,
    });
    const r = await driver.exec(handle, { cmd: 'pwd', args: [] });
    expect(r.exitCode).toBe(0);
    // macOS resolves /tmp to /private/tmp; compare via realpath.
    const realWorkspace = await fs.realpath(workspace);
    expect(r.stdout.trim()).toBe(realWorkspace);
  });

  it('exec() surfaces non-zero exit codes', async () => {
    const handle = await driver.start({
      runId: 'r1',
      projectId: 'p1',
      organizationId: 'o1',
      workspacePath: workspace,
    });
    const r = await driver.exec(handle, { cmd: 'sh', args: ['-c', 'exit 7'] });
    expect(r.exitCode).toBe(7);
  });

  it('exec() honors the per-call timeout', async () => {
    const handle = await driver.start({
      runId: 'r1',
      projectId: 'p1',
      organizationId: 'o1',
      workspacePath: workspace,
    });
    const r = await driver.exec(handle, {
      cmd: 'sh',
      args: ['-c', 'sleep 5'],
      timeoutMs: 100,
    });
    expect(r.timedOut).toBe(true);
  });

  it('exec() honors an external abort signal', async () => {
    const handle = await driver.start({
      runId: 'r1',
      projectId: 'p1',
      organizationId: 'o1',
      workspacePath: workspace,
    });
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 50);
    const r = await driver.exec(handle, {
      cmd: 'sh',
      args: ['-c', 'sleep 5'],
      signal: ac.signal,
    });
    // Either non-zero exit or a signal; what matters is that we returned
    // promptly instead of hanging on sleep.
    expect(r.exitCode !== 0 || r.signal != null).toBe(true);
  });

  it('readFile / writeFile round-trip via workspace-relative paths', async () => {
    const handle = await driver.start({
      runId: 'r1',
      projectId: 'p1',
      organizationId: 'o1',
      workspacePath: workspace,
    });
    await driver.writeFile(handle, 'sub/dir/file.txt', 'hello');
    const buf = await driver.readFile(handle, 'sub/dir/file.txt');
    expect(buf.toString()).toBe('hello');
  });

  it('readFile rejects absolute paths', async () => {
    const handle = await driver.start({
      runId: 'r1',
      projectId: 'p1',
      organizationId: 'o1',
      workspacePath: workspace,
    });
    await expect(driver.readFile(handle, '/etc/passwd')).rejects.toThrow(/absolute paths/);
  });

  it('readFile rejects path traversal', async () => {
    const handle = await driver.start({
      runId: 'r1',
      projectId: 'p1',
      organizationId: 'o1',
      workspacePath: workspace,
    });
    await expect(driver.readFile(handle, '../../../etc/passwd')).rejects.toThrow(/escapes the sandbox/);
  });

  it('writeFile rejects path traversal', async () => {
    const handle = await driver.start({
      runId: 'r1',
      projectId: 'p1',
      organizationId: 'o1',
      workspacePath: workspace,
    });
    await expect(driver.writeFile(handle, '../escape.txt', 'x')).rejects.toThrow(/escapes the sandbox/);
  });

  it('kill / stop are no-ops and do not throw', async () => {
    const handle = await driver.start({
      runId: 'r1',
      projectId: 'p1',
      organizationId: 'o1',
      workspacePath: workspace,
    });
    await expect(driver.kill(handle)).resolves.toBeUndefined();
    await expect(driver.stop(handle)).resolves.toBeUndefined();
  });
});

describe('buildSandboxDriver', () => {
  it('defaults to process driver', () => {
    const d = buildSandboxDriver();
    expect(d.name).toBe('process');
  });

  it('returns process driver for empty / unset mode', () => {
    expect(buildSandboxDriver({ mode: '' }).name).toBe('process');
    expect(buildSandboxDriver({ mode: 'PROCESS' }).name).toBe('process');
  });

  it('returns docker driver when mode is docker', () => {
    const d = buildSandboxDriver({ mode: 'docker' });
    expect(d.name).toBe('docker');
  });

  it('throws for unknown modes', () => {
    expect(() => buildSandboxDriver({ mode: 'firecracker' })).toThrow(/not recognized/);
  });

  it('logs a warning when running in process mode and a logger is supplied', () => {
    const calls: string[] = [];
    const logger = { info: () => {}, warn: (msg: string) => { calls.push(msg); }, error: () => {} };
    buildSandboxDriver({ logger });
    expect(calls.length).toBe(1);
    expect(calls[0]).toMatch(/unsandboxed/);
  });
});
