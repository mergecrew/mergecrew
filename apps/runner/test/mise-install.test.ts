import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ProcessDriver } from '@mergecrew/sandbox-driver';
import { maybeRunMiseInstall } from '../src/mise-install.js';

const logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
  trace: () => undefined,
  fatal: () => undefined,
  level: 'info',
  silent: () => undefined,
  child: () => logger,
} as any;

describe('maybeRunMiseInstall', () => {
  let workspace: string;
  let driver: ProcessDriver;
  let sandbox: Awaited<ReturnType<ProcessDriver['start']>>;

  beforeEach(async () => {
    workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'mise-test-'));
    driver = new ProcessDriver();
    sandbox = await driver.start({
      runId: 'r1',
      projectId: 'p1',
      organizationId: 'o1',
      workspacePath: workspace,
    });
  });

  afterEach(async () => {
    await driver.stop(sandbox);
    await fs.rm(workspace, { recursive: true, force: true });
  });

  it('skips when no .tool-versions or .mise.toml exists', async () => {
    const r = await maybeRunMiseInstall({ workspacePath: workspace, driver, sandbox, logger });
    expect(r).toEqual({ kind: 'skipped', reason: 'no_versions_file' });
  });

  it('skips with mise_not_available when mise is not on PATH', async () => {
    await fs.writeFile(path.join(workspace, '.tool-versions'), 'nodejs 20.0.0\n');
    // ProcessDriver inherits the supervisor's PATH; we mock the probe
    // by stubbing exec to return 127 for the `command -v mise` step.
    const realExec = driver.exec.bind(driver);
    const stub = vi.spyOn(driver, 'exec').mockImplementation(async (h, opts) => {
      if (opts.cmd === 'sh' && opts.args[1]?.includes('command -v mise')) {
        return { exitCode: 1, stdout: '', stderr: '', timedOut: false, signal: null };
      }
      return realExec(h, opts);
    });
    try {
      const r = await maybeRunMiseInstall({ workspacePath: workspace, driver, sandbox, logger });
      expect(r.kind).toBe('skipped');
      if (r.kind === 'skipped') expect(r.reason).toBe('mise_not_available');
    } finally {
      stub.mockRestore();
    }
  });

  it('runs mise install and writes the sentinel', async () => {
    await fs.writeFile(path.join(workspace, '.tool-versions'), 'nodejs 20.0.0\n');
    const realExec = driver.exec.bind(driver);
    const stub = vi.spyOn(driver, 'exec').mockImplementation(async (h, opts) => {
      if (opts.cmd === 'sh' && opts.args[1]?.includes('command -v mise')) {
        return { exitCode: 0, stdout: '/usr/local/bin/mise\n', stderr: '', timedOut: false, signal: null };
      }
      if (opts.cmd === 'mise') {
        return { exitCode: 0, stdout: 'installed\n', stderr: '', timedOut: false, signal: null };
      }
      return realExec(h, opts);
    });
    try {
      const r = await maybeRunMiseInstall({ workspacePath: workspace, driver, sandbox, logger });
      expect(r.kind).toBe('installed');
      // Sentinel was written.
      const sentinel = await fs.readFile(path.join(workspace, '.mergecrew-mise-installed'), 'utf8');
      expect(sentinel.length).toBeGreaterThan(10);
    } finally {
      stub.mockRestore();
    }
  });

  it('skips with cached when sentinel matches the current hash', async () => {
    await fs.writeFile(path.join(workspace, '.tool-versions'), 'nodejs 20.0.0\n');
    const realExec = driver.exec.bind(driver);
    const stub = vi.spyOn(driver, 'exec').mockImplementation(async (h, opts) => {
      if (opts.cmd === 'sh' && opts.args[1]?.includes('command -v mise')) {
        return { exitCode: 0, stdout: '', stderr: '', timedOut: false, signal: null };
      }
      if (opts.cmd === 'mise') {
        return { exitCode: 0, stdout: '', stderr: '', timedOut: false, signal: null };
      }
      return realExec(h, opts);
    });
    try {
      // First call installs.
      await maybeRunMiseInstall({ workspacePath: workspace, driver, sandbox, logger });
      // Second call sees the sentinel and skips.
      const r = await maybeRunMiseInstall({ workspacePath: workspace, driver, sandbox, logger });
      expect(r).toEqual({ kind: 'skipped', reason: 'cached' });
    } finally {
      stub.mockRestore();
    }
  });

  it('re-runs install when .tool-versions changes', async () => {
    await fs.writeFile(path.join(workspace, '.tool-versions'), 'nodejs 20.0.0\n');
    let installCount = 0;
    const realExec = driver.exec.bind(driver);
    const stub = vi.spyOn(driver, 'exec').mockImplementation(async (h, opts) => {
      if (opts.cmd === 'sh' && opts.args[1]?.includes('command -v mise')) {
        return { exitCode: 0, stdout: '', stderr: '', timedOut: false, signal: null };
      }
      if (opts.cmd === 'mise') {
        installCount += 1;
        return { exitCode: 0, stdout: '', stderr: '', timedOut: false, signal: null };
      }
      return realExec(h, opts);
    });
    try {
      await maybeRunMiseInstall({ workspacePath: workspace, driver, sandbox, logger });
      expect(installCount).toBe(1);
      // Edit .tool-versions; sentinel hash should mismatch.
      await fs.writeFile(path.join(workspace, '.tool-versions'), 'nodejs 22.0.0\n');
      await maybeRunMiseInstall({ workspacePath: workspace, driver, sandbox, logger });
      expect(installCount).toBe(2);
    } finally {
      stub.mockRestore();
    }
  });

  it('returns failed on non-zero mise install exit', async () => {
    await fs.writeFile(path.join(workspace, '.tool-versions'), 'nodejs 20.0.0\n');
    const stub = vi.spyOn(driver, 'exec').mockImplementation(async (h, opts) => {
      if (opts.cmd === 'sh') {
        return { exitCode: 0, stdout: '', stderr: '', timedOut: false, signal: null };
      }
      if (opts.cmd === 'mise') {
        return { exitCode: 1, stdout: '', stderr: 'tool not found', timedOut: false, signal: null };
      }
      return { exitCode: 0, stdout: '', stderr: '', timedOut: false, signal: null };
    });
    try {
      const r = await maybeRunMiseInstall({ workspacePath: workspace, driver, sandbox, logger });
      expect(r.kind).toBe('failed');
      if (r.kind === 'failed') {
        expect(r.exitCode).toBe(1);
        expect(r.stderr).toMatch(/tool not found/);
      }
    } finally {
      stub.mockRestore();
    }
  });
});
