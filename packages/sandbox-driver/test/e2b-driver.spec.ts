import { describe, expect, it, beforeEach, vi } from 'vitest';
import {
  E2BDriver,
  type E2BApiClient,
  type E2BCreateOpts,
} from '../src/e2b-driver.js';
import { CONTAINER_WORKSPACE } from '../src/docker-driver-constants.js';

function buildFakeApi() {
  const created: E2BCreateOpts[] = [];
  const commands: { sandboxId: string; cmd: string[]; stdin?: string | Buffer }[] = [];
  const reads: { sandboxId: string; path: string }[] = [];
  const writes: { sandboxId: string; path: string; data: string }[] = [];
  const killed: string[] = [];
  const api: E2BApiClient = {
    createSandbox: vi.fn(async (opts) => {
      created.push(opts);
      return `sbx-${created.length}`;
    }),
    runCommand: vi.fn(async (sandboxId, cmd, runOpts) => {
      commands.push({ sandboxId, cmd, stdin: runOpts.stdin });
      return { exitCode: 0, stdout: 'ok', stderr: '', timedOut: false };
    }),
    readFile: vi.fn(async (sandboxId, path) => {
      reads.push({ sandboxId, path });
      return Buffer.from('contents');
    }),
    writeFile: vi.fn(async (sandboxId, path, data) => {
      writes.push({ sandboxId, path, data: data.toString() });
    }),
    killSandbox: vi.fn(async (sandboxId) => {
      killed.push(sandboxId);
    }),
  };
  return { api, created, commands, reads, writes, killed };
}

describe('E2BDriver', () => {
  let drv: E2BDriver;
  let fake: ReturnType<typeof buildFakeApi>;

  beforeEach(() => {
    fake = buildFakeApi();
    drv = new E2BDriver({ api: fake.api, defaultTemplate: 'mergecrew-polyglot' });
  });

  it('start() creates a sandbox with mergecrew metadata + surfaces a handle', async () => {
    const handle = await drv.start({
      runId: 'run-1',
      projectId: 'proj-1',
      organizationId: 'org-1',
      workspacePath: '/tmp/ws',
      image: 'mergecrew-node',
      resources: { timeoutMs: 60_000 },
    });
    expect(handle.driver).toBe('e2b');
    expect(handle.workspacePath).toBe(CONTAINER_WORKSPACE);
    expect(handle.id).toBe('sbx-1');
    expect(fake.created[0]!.template).toBe('mergecrew-node');
    expect(fake.created[0]!.metadata).toEqual({
      'mergecrew.run-id': 'run-1',
      'mergecrew.project-id': 'proj-1',
      'mergecrew.organization-id': 'org-1',
    });
    expect(fake.created[0]!.timeoutMs).toBe(60_000);
  });

  it('falls back to the default template when image is empty', async () => {
    await drv.start({
      runId: 'r',
      projectId: 'p',
      organizationId: 'o',
      workspacePath: '/tmp/ws',
    });
    expect(fake.created[0]!.template).toBe('mergecrew-polyglot');
  });

  it('emits cold_start_ms metric and warns when over target', async () => {
    const warn = vi.fn();
    const metric = vi.fn();
    const slowApi = {
      ...fake.api,
      createSandbox: vi.fn(async (opts) => {
        await new Promise((r) => setTimeout(r, 30));
        return 'sbx-slow';
      }),
    } as E2BApiClient;
    const d = new E2BDriver({
      api: slowApi,
      coldStartTargetMs: 1,
      logger: { info: () => {}, warn, error: () => {}, metric },
    });
    await d.start({
      runId: 'r',
      projectId: 'p',
      organizationId: 'o',
      workspacePath: '/tmp/ws',
    });
    expect(metric).toHaveBeenCalledWith(
      'e2b.cold_start_ms',
      expect.any(Number),
      expect.objectContaining({ runId: 'r' }),
    );
    expect(warn).toHaveBeenCalled();
  });

  it('exec wraps cmd in sh -c with cwd + env', async () => {
    const handle = await drv.start({
      runId: 'r',
      projectId: 'p',
      organizationId: 'o',
      workspacePath: '/tmp/ws',
    });
    fake.commands.length = 0;
    await drv.exec(handle, {
      cmd: 'pytest',
      args: ['-x'],
      cwd: 'tests',
      env: { PYTHONPATH: 'src' },
    });
    expect(fake.commands).toHaveLength(1);
    const cmd = fake.commands[0]!.cmd;
    expect(cmd[0]).toBe('sh');
    expect(cmd[2]).toContain(`cd ${CONTAINER_WORKSPACE}/tests`);
    expect(cmd[2]).toContain('export PYTHONPATH=src');
    expect(cmd[2]).toContain('pytest -x');
  });

  it('readFile passes through the absolute workspace path', async () => {
    const handle = await drv.start({
      runId: 'r',
      projectId: 'p',
      organizationId: 'o',
      workspacePath: '/tmp/ws',
    });
    const buf = await drv.readFile(handle, 'src/app.ts');
    expect(buf.toString('utf8')).toBe('contents');
    expect(fake.reads[0]!.path).toBe(`${CONTAINER_WORKSPACE}/src/app.ts`);
  });

  it('writeFile passes through stdin + path', async () => {
    const handle = await drv.start({
      runId: 'r',
      projectId: 'p',
      organizationId: 'o',
      workspacePath: '/tmp/ws',
    });
    await drv.writeFile(handle, 'a.txt', 'hi');
    expect(fake.writes[0]!.path).toBe(`${CONTAINER_WORKSPACE}/a.txt`);
    expect(fake.writes[0]!.data).toBe('hi');
  });

  it('absolute paths outside /workspace are rejected', async () => {
    const handle = await drv.start({
      runId: 'r',
      projectId: 'p',
      organizationId: 'o',
      workspacePath: '/tmp/ws',
    });
    await expect(drv.readFile(handle, '/etc/passwd')).rejects.toThrow(/must live under/);
  });

  it('stop kills the sandbox + forgets the handle', async () => {
    const handle = await drv.start({
      runId: 'r',
      projectId: 'p',
      organizationId: 'o',
      workspacePath: '/tmp/ws',
    });
    await drv.stop(handle);
    expect(fake.killed).toContain(handle.id);
    // Second stop is a no-op.
    await drv.stop(handle);
    expect(fake.killed).toEqual([handle.id]);
  });
});
