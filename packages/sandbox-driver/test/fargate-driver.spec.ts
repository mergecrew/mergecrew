import { describe, expect, it, beforeEach, vi } from 'vitest';
import {
  FargateDriver,
  type FargateApiClient,
  type FargateRunTaskSpec,
} from '../src/fargate-driver.js';
import { CONTAINER_WORKSPACE } from '../src/docker-driver-constants.js';

function buildFakeApi(): {
  api: FargateApiClient;
  starts: FargateRunTaskSpec[];
  execs: { cmd: string[]; stdin?: string | Buffer }[];
  stops: { arn: string; reason: string }[];
} {
  const starts: FargateRunTaskSpec[] = [];
  const execs: { cmd: string[]; stdin?: string | Buffer }[] = [];
  const stops: { arn: string; reason: string }[] = [];
  const api: FargateApiClient = {
    runTask: vi.fn(async (spec) => {
      starts.push(spec);
      return `arn:aws:ecs:us-east-1:111111111111:task/test-cluster/task-${starts.length}`;
    }),
    waitForTaskRunning: vi.fn(async () => {
      // Simulate a small cold start so the metric callback fires.
      await new Promise((r) => setTimeout(r, 5));
    }),
    executeCommand: vi.fn(async (_arn, cmd, opts) => {
      execs.push({ cmd, stdin: opts.stdin });
      return { exitCode: 0, stdout: 'ok', stderr: '', timedOut: false };
    }),
    stopTask: vi.fn(async (arn, reason) => {
      stops.push({ arn, reason });
    }),
  };
  return { api, starts, execs, stops };
}

describe('FargateDriver', () => {
  let drv: FargateDriver;
  let fake: ReturnType<typeof buildFakeApi>;

  beforeEach(() => {
    fake = buildFakeApi();
    drv = new FargateDriver({
      api: fake.api,
      cluster: 'mergecrew-fargate',
      taskDefinition: 'mergecrew-runner:1',
      subnets: ['subnet-aaa', 'subnet-bbb'],
      securityGroups: ['sg-1'],
      defaultImage: 'ghcr.io/mergecrew/runner-polyglot:latest',
    });
  });

  it('start() runs a task with private networking and surfaces the handle', async () => {
    const handle = await drv.start({
      runId: 'run-abc',
      projectId: 'proj-1',
      organizationId: 'org-1',
      workspacePath: '/var/mergecrew/work/run-abc',
      resources: { cpu: 1, memoryMb: 2048 },
    });
    expect(handle.driver).toBe('fargate');
    expect(handle.workspacePath).toBe(CONTAINER_WORKSPACE);
    expect(handle.id).toMatch(/^arn:aws:ecs:/);
    expect(fake.starts).toHaveLength(1);
    expect(fake.starts[0]!.cluster).toBe('mergecrew-fargate');
    expect(fake.starts[0]!.subnets).toEqual(['subnet-aaa', 'subnet-bbb']);
    expect(fake.starts[0]!.assignPublicIp).toBe(false);
    expect(fake.starts[0]!.tags['mergecrew:run-id']).toBe('run-abc');
    // CPU+memory threaded through.
    expect(fake.starts[0]!.overrides.cpu).toBe(1);
    expect(fake.starts[0]!.overrides.memoryMb).toBe(2048);
  });

  it('emits a cold-start metric via logger.metric', async () => {
    const metric = vi.fn();
    const d = new FargateDriver({
      api: fake.api,
      cluster: 'c',
      taskDefinition: 'td',
      subnets: ['s'],
      securityGroups: ['sg'],
      logger: {
        info: () => {},
        warn: () => {},
        error: () => {},
        metric,
      },
    });
    await d.start({
      runId: 'r',
      projectId: 'p',
      organizationId: 'o',
      workspacePath: '/tmp/ws',
    });
    expect(metric).toHaveBeenCalledWith(
      'fargate.cold_start_ms',
      expect.any(Number),
      expect.objectContaining({ runId: 'r' }),
    );
  });

  it('start() rejects + stops the task if it never reaches RUNNING', async () => {
    (fake.api.waitForTaskRunning as any).mockRejectedValueOnce(new Error('timeout'));
    await expect(
      drv.start({
        runId: 'r',
        projectId: 'p',
        organizationId: 'o',
        workspacePath: '/tmp/ws',
      }),
    ).rejects.toThrow(/timeout/);
    expect(fake.stops).toHaveLength(1);
  });

  it('exec wraps cwd + env + cmd in sh -c', async () => {
    const handle = await drv.start({
      runId: 'r',
      projectId: 'p',
      organizationId: 'o',
      workspacePath: '/tmp/ws',
    });
    fake.execs.length = 0;
    await drv.exec(handle, { cmd: 'npm', args: ['ci'], cwd: 'app', env: { CI: '1' } });
    expect(fake.execs).toHaveLength(1);
    const cmd = fake.execs[0]!.cmd;
    expect(cmd[0]).toBe('sh');
    expect(cmd[1]).toBe('-c');
    expect(cmd[2]).toContain(`cd ${CONTAINER_WORKSPACE}/app`);
    expect(cmd[2]).toContain('export CI=1');
    expect(cmd[2]).toContain('npm ci');
  });

  it('readFile execs cat at the workspace-relative path', async () => {
    const handle = await drv.start({
      runId: 'r',
      projectId: 'p',
      organizationId: 'o',
      workspacePath: '/tmp/ws',
    });
    const buf = await drv.readFile(handle, 'src/app.ts');
    expect(buf.toString('utf8')).toBe('ok');
    const last = fake.execs[fake.execs.length - 1]!;
    expect(last.cmd).toEqual(['cat', `${CONTAINER_WORKSPACE}/src/app.ts`]);
  });

  it('writeFile execs tee with stdin and mkdir -p', async () => {
    const handle = await drv.start({
      runId: 'r',
      projectId: 'p',
      organizationId: 'o',
      workspacePath: '/tmp/ws',
    });
    await drv.writeFile(handle, 'a/b/c.txt', 'hi');
    const last = fake.execs[fake.execs.length - 1]!;
    expect(last.cmd[0]).toBe('sh');
    expect(last.cmd[2]).toContain('mkdir -p');
    expect(last.cmd[2]).toContain(`tee ${CONTAINER_WORKSPACE}/a/b/c.txt`);
    expect(last.stdin?.toString()).toBe('hi');
  });

  it('absolute path outside /workspace is rejected', async () => {
    const handle = await drv.start({
      runId: 'r',
      projectId: 'p',
      organizationId: 'o',
      workspacePath: '/tmp/ws',
    });
    await expect(drv.readFile(handle, '/etc/passwd')).rejects.toThrow(/must live under/);
  });

  it('stop calls StopTask with a normal reason', async () => {
    const handle = await drv.start({
      runId: 'r',
      projectId: 'p',
      organizationId: 'o',
      workspacePath: '/tmp/ws',
    });
    await drv.stop(handle);
    expect(fake.stops).toHaveLength(1);
    expect(fake.stops[0]!.reason).toBe('normal sandbox lifecycle end');
  });
});
