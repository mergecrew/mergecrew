import { describe, expect, it, beforeEach, vi } from 'vitest';
import {
  K8sDriver,
  type K8sApiClient,
  type K8sJobSpec,
  type K8sNetworkPolicySpec,
} from '../src/k8s-driver.js';
import { CONTAINER_WORKSPACE, SANDBOX_UID } from '../src/docker-driver-constants.js';

function buildFakeApi(): {
  api: K8sApiClient;
  jobs: K8sJobSpec[];
  policies: K8sNetworkPolicySpec[];
  execCalls: { cmd: string[]; stdin?: string | Buffer }[];
  deletedJobs: string[];
  deletedPolicies: string[];
} {
  const jobs: K8sJobSpec[] = [];
  const policies: K8sNetworkPolicySpec[] = [];
  const execCalls: { cmd: string[]; stdin?: string | Buffer }[] = [];
  const deletedJobs: string[] = [];
  const deletedPolicies: string[] = [];
  const api: K8sApiClient = {
    createJob: vi.fn(async (_ns, spec) => {
      jobs.push(spec);
      return spec.name;
    }),
    createNetworkPolicy: vi.fn(async (_ns, spec) => {
      policies.push(spec);
    }),
    waitForPodReady: vi.fn(async (_ns, jobName) => `${jobName}-pod`),
    execInPod: vi.fn(async (_ns, _pod, cmd, opts) => {
      execCalls.push({ cmd, stdin: opts.stdin });
      return { exitCode: 0, stdout: 'ok', stderr: '', timedOut: false };
    }),
    deleteJob: vi.fn(async (_ns, name) => {
      deletedJobs.push(name);
    }),
    deleteNetworkPolicy: vi.fn(async (_ns, name) => {
      deletedPolicies.push(name);
    }),
  };
  return { api, jobs, policies, execCalls, deletedJobs, deletedPolicies };
}

describe('K8sDriver', () => {
  let drv: K8sDriver;
  let fake: ReturnType<typeof buildFakeApi>;

  beforeEach(() => {
    fake = buildFakeApi();
    drv = new K8sDriver({ api: fake.api, namespace: 'mergecrew-runners' });
  });

  it('start() creates a NetworkPolicy before the Job and surfaces the handle', async () => {
    const handle = await drv.start({
      runId: 'run-12345',
      projectId: 'proj-1',
      organizationId: 'org-1',
      workspacePath: '/var/mergecrew/work/run-12345',
      image: 'ghcr.io/mergecrew/runner-node:20',
      resources: { cpu: 2, memoryMb: 1024 },
    });
    expect(handle.driver).toBe('kubernetes');
    expect(handle.workspacePath).toBe(CONTAINER_WORKSPACE);

    // NetworkPolicy comes first so the Pod can't be unmetered between
    // schedule and policy apply.
    expect((fake.api.createNetworkPolicy as any).mock.invocationCallOrder[0]).toBeLessThan(
      (fake.api.createJob as any).mock.invocationCallOrder[0],
    );

    expect(fake.jobs).toHaveLength(1);
    expect(fake.jobs[0]!.image).toBe('ghcr.io/mergecrew/runner-node:20');
    expect(fake.jobs[0]!.labels['mergecrew.io/run-id']).toBe('run-12345');
    expect(fake.jobs[0]!.ttlSecondsAfterFinished).toBe(300);
    expect(fake.jobs[0]!.resources?.cpu).toBe(2);
    expect(fake.jobs[0]!.resources?.memoryMb).toBe(1024);
  });

  it('default NetworkPolicy denies egress except DNS', async () => {
    await drv.start({
      runId: 'r',
      projectId: 'p',
      organizationId: 'o',
      workspacePath: '/tmp/ws',
    });
    const p = fake.policies[0]!;
    expect(p.egress).toHaveLength(1);
    expect(p.egress?.[0]!.ports).toEqual([
      { protocol: 'UDP', port: 53 },
      { protocol: 'TCP', port: 53 },
    ]);
  });

  it('NetworkPolicy opens 80/443 when an egress allowlist is set', async () => {
    await drv.start({
      runId: 'r',
      projectId: 'p',
      organizationId: 'o',
      workspacePath: '/tmp/ws',
      egressAllowlist: ['api.example.com'],
    });
    const p = fake.policies[0]!;
    // 53/53 first then 80+443.
    expect(p.egress).toHaveLength(2);
    expect(p.egress?.[1]!.ports?.map((x) => x.port)).toEqual([80, 443]);
  });

  it('exec() wraps cmd + args in sh -c with cwd and env, no leakage', async () => {
    const handle = await drv.start({
      runId: 'r',
      projectId: 'p',
      organizationId: 'o',
      workspacePath: '/tmp/ws',
    });
    fake.execCalls.length = 0;
    await drv.exec(handle, {
      cmd: 'echo',
      args: ['hello world'],
      cwd: 'subdir',
      env: { FOO: 'bar baz' },
    });
    expect(fake.execCalls).toHaveLength(1);
    const cmd = fake.execCalls[0]!.cmd;
    expect(cmd[0]).toBe('sh');
    expect(cmd[1]).toBe('-c');
    const script = cmd[2]!;
    expect(script).toContain(`cd ${CONTAINER_WORKSPACE}/subdir`);
    expect(script).toContain("export FOO='bar baz'");
    expect(script).toContain("echo 'hello world'");
  });

  it('readFile execs cat at the workspace-relative path', async () => {
    const handle = await drv.start({
      runId: 'r',
      projectId: 'p',
      organizationId: 'o',
      workspacePath: '/tmp/ws',
    });
    const buf = await drv.readFile(handle, 'src/app.ts');
    // Default fake returns stdout='ok' for all execs.
    expect(buf.toString('utf8')).toBe('ok');
    const lastCall = fake.execCalls[fake.execCalls.length - 1]!;
    expect(lastCall.cmd).toEqual(['cat', `${CONTAINER_WORKSPACE}/src/app.ts`]);
  });

  it('writeFile execs tee with stdin and mkdir -p the directory', async () => {
    const handle = await drv.start({
      runId: 'r',
      projectId: 'p',
      organizationId: 'o',
      workspacePath: '/tmp/ws',
    });
    await drv.writeFile(handle, 'a/b/c.txt', 'hello');
    const lastCall = fake.execCalls[fake.execCalls.length - 1]!;
    expect(lastCall.cmd[0]).toBe('sh');
    expect(lastCall.cmd[2]).toContain('mkdir -p');
    expect(lastCall.cmd[2]).toContain(`tee ${CONTAINER_WORKSPACE}/a/b/c.txt`);
    expect(lastCall.stdin?.toString()).toBe('hello');
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

  it('stop deletes Job and NetworkPolicy', async () => {
    const handle = await drv.start({
      runId: 'r',
      projectId: 'p',
      organizationId: 'o',
      workspacePath: '/tmp/ws',
    });
    await drv.stop(handle);
    expect(fake.deletedJobs).toHaveLength(1);
    expect(fake.deletedPolicies).toHaveLength(1);
  });

  it('start failure leaves no resources behind', async () => {
    (fake.api.waitForPodReady as any).mockRejectedValueOnce(new Error('image pull failed'));
    await expect(
      drv.start({
        runId: 'r',
        projectId: 'p',
        organizationId: 'o',
        workspacePath: '/tmp/ws',
      }),
    ).rejects.toThrow(/image pull failed/);
    expect(fake.deletedJobs).toHaveLength(1);
    expect(fake.deletedPolicies).toHaveLength(1);
  });

  it('uses defaultImage when SandboxStartOpts.image is empty', async () => {
    const d = new K8sDriver({
      api: fake.api,
      namespace: 'ns',
      defaultImage: 'ghcr.io/foo/bar:1.0',
    });
    await d.start({
      runId: 'r',
      projectId: 'p',
      organizationId: 'o',
      workspacePath: '/tmp/ws',
    });
    expect(fake.jobs[0]!.image).toBe('ghcr.io/foo/bar:1.0');
  });

  it('drives the workspace mountPath at the canonical sandbox path constant', async () => {
    const handle = await drv.start({
      runId: 'r',
      projectId: 'p',
      organizationId: 'o',
      workspacePath: '/tmp/ws',
    });
    expect(handle.workspacePath).toBe(CONTAINER_WORKSPACE);
    // Sanity: SANDBOX_UID stays at the expected value (string form so
    // it round-trips through CLI args). The real k8s-api-client maps
    // this onto runAsUser as a number.
    expect(Number(SANDBOX_UID)).toBe(1001);
  });
});
