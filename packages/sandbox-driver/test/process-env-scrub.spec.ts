import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ProcessDriver } from '../src/process-driver.js';

/**
 * Threat T-1/T-3/T-4 from #554: the V0 ProcessDriver inherited the
 * supervisor's process.env, so any subprocess could read
 * KMS_MASTER_KEY / GITHUB_APP_PRIVATE_KEY / AWS_*. These tests assert
 * the env scrub introduced in #561 actually drops those vars.
 */
describe('ProcessDriver env scrub', () => {
  let workspace: string;
  let driver: ProcessDriver;

  beforeEach(async () => {
    workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'env-scrub-test-'));
    driver = new ProcessDriver();
  });

  afterEach(async () => {
    await fs.rm(workspace, { recursive: true, force: true });
  });

  async function runWithSupervisorEnv(extra: Record<string, string>) {
    // Stash + restore so the test doesn't leak into sibling tests.
    const before: Record<string, string | undefined> = {};
    for (const k of Object.keys(extra)) {
      before[k] = process.env[k];
      process.env[k] = extra[k];
    }
    try {
      const handle = await driver.start({
        runId: 'r1',
        projectId: 'p1',
        organizationId: 'o1',
        workspacePath: workspace,
      });
      const r = await driver.exec(handle, {
        cmd: 'sh',
        args: [
          '-c',
          // env | grep returns 1 when no match — print empty so we can
          // assert on stdout regardless.
          'env | grep -E "^(KMS_MASTER_KEY|GITHUB_APP_PRIVATE_KEY|AWS_SECRET_ACCESS_KEY|ANTHROPIC_API_KEY)=" || true',
        ],
      });
      return r;
    } finally {
      for (const [k, v] of Object.entries(before)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  }

  it('KMS_MASTER_KEY does not leak into the subprocess', async () => {
    const r = await runWithSupervisorEnv({ KMS_MASTER_KEY: 'should-not-leak' });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).not.toContain('should-not-leak');
    expect(r.stdout).not.toContain('KMS_MASTER_KEY');
  });

  it('GITHUB_APP_PRIVATE_KEY does not leak into the subprocess', async () => {
    const r = await runWithSupervisorEnv({ GITHUB_APP_PRIVATE_KEY: 'PEM-secret' });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).not.toContain('PEM-secret');
    expect(r.stdout).not.toContain('GITHUB_APP_PRIVATE_KEY');
  });

  it('AWS_SECRET_ACCESS_KEY does not leak into the subprocess', async () => {
    const r = await runWithSupervisorEnv({ AWS_SECRET_ACCESS_KEY: 'AKIA-leak' });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).not.toContain('AKIA-leak');
  });

  it('ANTHROPIC_API_KEY does not leak into the subprocess', async () => {
    const r = await runWithSupervisorEnv({ ANTHROPIC_API_KEY: 'sk-ant-leak' });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).not.toContain('sk-ant-leak');
  });

  it('explicit opts.env values DO reach the subprocess', async () => {
    const handle = await driver.start({
      runId: 'r1',
      projectId: 'p1',
      organizationId: 'o1',
      workspacePath: workspace,
    });
    const r = await driver.exec(handle, {
      cmd: 'sh',
      args: ['-c', 'echo "$MY_PROJECT_VAR"'],
      env: { MY_PROJECT_VAR: 'allowed' },
    });
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe('allowed');
  });

  it('explicit sensitive opts.env values are honored AND warn', async () => {
    const calls: Array<{ msg: string; meta?: any }> = [];
    const d = new ProcessDriver({
      logger: {
        info: () => {},
        warn: (msg, meta) => calls.push({ msg, meta }),
        error: () => {},
      },
    });
    const handle = await d.start({
      runId: 'r1',
      projectId: 'p1',
      organizationId: 'o1',
      workspacePath: workspace,
    });
    const r = await d.exec(handle, {
      cmd: 'sh',
      args: ['-c', 'echo "$AWS_ACCESS_KEY_ID"'],
      env: { AWS_ACCESS_KEY_ID: 'project-scoped-on-purpose' },
    });
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe('project-scoped-on-purpose');
    expect(calls.length).toBe(1);
    expect(calls[0]!.meta.key).toBe('AWS_ACCESS_KEY_ID');
    expect(calls[0]!.meta.prefix).toBe('AWS_');
  });

  it('PATH from the supervisor is still propagated (allowed base)', async () => {
    const handle = await driver.start({
      runId: 'r1',
      projectId: 'p1',
      organizationId: 'o1',
      workspacePath: workspace,
    });
    const r = await driver.exec(handle, { cmd: 'sh', args: ['-c', 'echo "$PATH"'] });
    expect(r.exitCode).toBe(0);
    // PATH from process.env should be present. We don't assert a specific
    // value (it varies by host), just that it's nonempty.
    expect(r.stdout.trim().length).toBeGreaterThan(0);
  });
});
