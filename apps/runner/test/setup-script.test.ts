import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ProcessDriver } from '@mergecrew/sandbox-driver';
import { maybeRunSetup } from '../src/setup-script.js';

const logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
  trace: () => undefined,
  fatal: () => undefined,
  silent: () => undefined,
  level: 'info',
  child: () => logger,
} as any;

describe('maybeRunSetup', () => {
  let workspace: string;
  let driver: ProcessDriver;
  let sandbox: Awaited<ReturnType<ProcessDriver['start']>>;

  beforeEach(async () => {
    workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'setup-test-'));
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

  it('returns no_setup when undefined', async () => {
    const r = await maybeRunSetup({ workspacePath: workspace, driver, sandbox, setup: undefined, logger });
    expect(r.kind).toBe('no_setup');
  });

  it('returns no_setup when empty array', async () => {
    const r = await maybeRunSetup({ workspacePath: workspace, driver, sandbox, setup: [], logger });
    expect(r.kind).toBe('no_setup');
  });

  it('runs each command sequentially and writes the sentinel', async () => {
    const r = await maybeRunSetup({
      workspacePath: workspace,
      driver,
      sandbox,
      setup: ['echo step1 > /tmp/m1.log', 'echo step2 >> /tmp/m1.log'],
      logger,
    });
    expect(r.kind).toBe('ran');
    const sentinel = await fs.readFile(path.join(workspace, '.mergecrew-setup-installed'), 'utf8');
    expect(sentinel.length).toBeGreaterThan(20);
  });

  it('returns cached on a second call with the same setup', async () => {
    const setup = ['true'];
    await maybeRunSetup({ workspacePath: workspace, driver, sandbox, setup, logger });
    const second = await maybeRunSetup({ workspacePath: workspace, driver, sandbox, setup, logger });
    expect(second.kind).toBe('cached');
  });

  it('re-runs when setup commands change', async () => {
    await maybeRunSetup({ workspacePath: workspace, driver, sandbox, setup: ['true'], logger });
    const second = await maybeRunSetup({
      workspacePath: workspace,
      driver,
      sandbox,
      setup: ['echo bumped'],
      logger,
    });
    expect(second.kind).toBe('ran');
  });

  it('returns failed on the first non-zero exit and surfaces command + exit', async () => {
    const r = await maybeRunSetup({
      workspacePath: workspace,
      driver,
      sandbox,
      setup: ['true', 'exit 17', 'echo never-runs'],
      logger,
    });
    expect(r.kind).toBe('failed');
    if (r.kind === 'failed') {
      expect(r.exitCode).toBe(17);
      expect(r.command).toBe('exit 17');
    }
    // Sentinel must not be written on failure.
    await expect(fs.access(path.join(workspace, '.mergecrew-setup-installed'))).rejects.toThrow();
  });
});
