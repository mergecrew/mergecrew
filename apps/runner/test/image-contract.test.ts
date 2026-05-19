import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ProcessDriver } from '@mergecrew/sandbox-driver';
import type { ExecOpts, ExecResult, SandboxDriver, SandboxHandle, SandboxStartOpts } from '@mergecrew/sandbox-driver';
import { validateImageContract, summarizeViolations } from '../src/image-contract.js';

/**
 * Fake driver that returns scripted exec results. Mirrors the docker
 * driver's surface so we can assert what the validator sends and
 * compose violations without spinning up a container.
 */
class FakeDriver implements SandboxDriver {
  readonly name = 'docker';
  constructor(private readonly script: (opts: ExecOpts) => Partial<ExecResult>) {}
  async start(opts: SandboxStartOpts): Promise<SandboxHandle> {
    return { id: 'cid', driver: 'docker', workspacePath: '/workspace', ...opts };
  }
  async exec(_h: SandboxHandle, opts: ExecOpts): Promise<ExecResult> {
    const r = this.script(opts);
    return {
      exitCode: r.exitCode ?? 0,
      stdout: r.stdout ?? '',
      stderr: r.stderr ?? '',
      timedOut: r.timedOut ?? false,
      signal: r.signal ?? null,
    };
  }
  async readFile() { return Buffer.from(''); }
  async writeFile() { /* no-op */ }
  async kill() { /* no-op */ }
  async stop() { /* no-op */ }
}

async function makeFakeHandle(): Promise<SandboxHandle> {
  return { id: 'cid', driver: 'docker', workspacePath: '/workspace' };
}

describe('validateImageContract', () => {
  it('returns ok when uid + workspace + binaries all pass', async () => {
    const driver = new FakeDriver((opts) => {
      if (opts.cmd === 'id') return { exitCode: 0, stdout: '1001\n' };
      if (opts.cmd === 'sh' && opts.args[1]?.includes('command -v')) return { exitCode: 0 };
      if (opts.cmd === 'sh' && opts.args[1]?.includes('touch')) return { exitCode: 0 };
      return { exitCode: 0 };
    });
    const r = await validateImageContract({ driver, sandbox: await makeFakeHandle() });
    expect(r.ok).toBe(true);
    expect(r.violations).toHaveLength(0);
  });

  it('reports a violation when uid is not 1001', async () => {
    const driver = new FakeDriver((opts) => {
      if (opts.cmd === 'id') return { exitCode: 0, stdout: '0\n' };
      return { exitCode: 0 };
    });
    const r = await validateImageContract({ driver, sandbox: await makeFakeHandle() });
    expect(r.ok).toBe(false);
    expect(r.violations.some((v) => v.property === 'default_user_uid')).toBe(true);
  });

  it('reports a violation when /workspace is not writable', async () => {
    const driver = new FakeDriver((opts) => {
      if (opts.cmd === 'id') return { exitCode: 0, stdout: '1001\n' };
      if (opts.cmd === 'sh' && opts.args[1]?.includes('touch'))
        return { exitCode: 1, stderr: 'permission denied' };
      return { exitCode: 0 };
    });
    const r = await validateImageContract({ driver, sandbox: await makeFakeHandle() });
    expect(r.ok).toBe(false);
    expect(r.violations.some((v) => v.property === '/workspace_writable')).toBe(true);
  });

  it('reports a violation when git is missing', async () => {
    const driver = new FakeDriver((opts) => {
      if (opts.cmd === 'id') return { exitCode: 0, stdout: '1001\n' };
      if (opts.cmd === 'sh' && opts.args[1]?.includes('touch')) return { exitCode: 0 };
      if (opts.cmd === 'sh' && opts.args[1]?.includes('command -v git')) return { exitCode: 1 };
      if (opts.cmd === 'sh' && opts.args[1]?.includes('command -v')) return { exitCode: 0 };
      return { exitCode: 0 };
    });
    const r = await validateImageContract({ driver, sandbox: await makeFakeHandle() });
    expect(r.ok).toBe(false);
    expect(r.violations.some((v) => v.property === 'binary:git')).toBe(true);
  });

  it('aggregates multiple violations', async () => {
    const driver = new FakeDriver((opts) => {
      if (opts.cmd === 'id') return { exitCode: 0, stdout: '0\n' };
      if (opts.cmd === 'sh' && opts.args[1]?.includes('touch'))
        return { exitCode: 1 };
      if (opts.cmd === 'sh' && opts.args[1]?.includes('command -v'))
        return { exitCode: 1 };
      return { exitCode: 0 };
    });
    const r = await validateImageContract({ driver, sandbox: await makeFakeHandle() });
    expect(r.violations.length).toBeGreaterThan(1);
    const summary = summarizeViolations(r.violations);
    expect(summary).toMatch(/default_user_uid/);
    expect(summary).toMatch(/\/workspace_writable/);
  });

  it('passes trivially for ProcessDriver (contract structurally inapplicable)', async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'process-contract-'));
    const driver = new ProcessDriver();
    const sandbox = await driver.start({
      runId: 'r1',
      projectId: 'p1',
      organizationId: 'o1',
      workspacePath: workspace,
    });
    try {
      const r = await validateImageContract({ driver, sandbox });
      expect(r.ok).toBe(true);
    } finally {
      await driver.stop(sandbox);
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });
});

describe('summarizeViolations', () => {
  it('returns "ok" for an empty list', () => {
    expect(summarizeViolations([])).toBe('ok');
  });

  it('joins multiple entries with "; "', () => {
    const s = summarizeViolations([
      { property: 'a', expected: 'x', actual: 'y' },
      { property: 'b', expected: 'p', actual: 'q' },
    ]);
    expect(s).toBe('a: expected x, got y; b: expected p, got q');
  });
});
