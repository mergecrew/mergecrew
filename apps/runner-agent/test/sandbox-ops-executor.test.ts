/**
 * Unit tests for the agent's sandbox-op dispatch (V2.ag step 3).
 * Tests `executeOp` in isolation: routes each op to the right
 * SandboxDriver method, manages the handle from the `start` op,
 * encodes/decodes base64 for file I/O, rejects ops on a null
 * handle when one is required, rejects unknown ops.
 *
 * Loop-level behavior (poll/idle/step-done exit, postResult on
 * error) is covered separately by the orchestrator-side protocol
 * integration test (apps/orchestrator/test/sandbox-ops-protocol.test.ts).
 */

import { describe, expect, it, vi } from 'vitest';
import { executeOp } from '../src/sandbox-ops-executor.js';
import type {
  ExecOpts,
  ExecResult,
  SandboxDriver,
  SandboxHandle,
  SandboxStartOpts,
} from '@mergecrew/sandbox-driver';
import type { Logger } from '../src/logger.js';

const FAKE_HANDLE: SandboxHandle = {
  id: 'sandbox-1',
  driver: 'process',
  workspacePath: '/agent/work',
};

const silentLogger: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
  trace: () => undefined,
} as unknown as Logger;

function makeFakeDriver(overrides: Partial<SandboxDriver> = {}): SandboxDriver {
  return {
    name: 'fake',
    async start(_opts: SandboxStartOpts) {
      return FAKE_HANDLE;
    },
    async exec(_handle, _opts) {
      return { exitCode: 0, stdout: 'fake-out', stderr: '', timedOut: false } as ExecResult;
    },
    async readFile(_handle, _rel) {
      return Buffer.from('contents');
    },
    async writeFile(_handle, _rel, _data) {
      return;
    },
    async kill(_handle, _signal) {
      return;
    },
    async stop(_handle) {
      return;
    },
    ...overrides,
  };
}

describe('executeOp — op dispatch', () => {
  it('start: invokes driver.start, returns the SandboxHandle', async () => {
    const startSpy = vi.fn(async () => FAKE_HANDLE);
    const driver = makeFakeDriver({ start: startSpy });
    const result = await executeOp(
      driver,
      null,
      {
        opId: 'a',
        op: 'start',
        args: {
          runId: 'run-1',
          projectId: 'p',
          organizationId: 'o',
          workspacePath: '/supervisor-host/path',
        } as SandboxStartOpts,
      },
      silentLogger,
    );
    expect(result).toEqual(FAKE_HANDLE);
    expect(startSpy).toHaveBeenCalledTimes(1);
    // The agent ignores the supervisor's host workspacePath and
    // substitutes its own agent-local dir (ADR-0009).
    const call = startSpy.mock.calls[0]![0];
    expect(call.workspacePath).not.toBe('/supervisor-host/path');
    expect(call.workspacePath).toContain('mergecrew-runner-agent');
  });

  it('exec: routes to driver.exec with the args', async () => {
    const execSpy = vi.fn(
      async (_h: SandboxHandle, _o: ExecOpts): Promise<ExecResult> => ({
        exitCode: 0,
        stdout: 'ok',
        stderr: '',
        timedOut: false,
      }),
    );
    const driver = makeFakeDriver({ exec: execSpy });
    const result = await executeOp(
      driver,
      FAKE_HANDLE,
      { opId: 'e', op: 'exec', args: { cmd: 'ls', args: ['-la'] } },
      silentLogger,
    );
    expect((result as ExecResult).stdout).toBe('ok');
    expect(execSpy).toHaveBeenCalledWith(FAKE_HANDLE, { cmd: 'ls', args: ['-la'] });
  });

  it('readFile: returns base64-encoded buffer', async () => {
    const driver = makeFakeDriver({
      async readFile() {
        return Buffer.from('hello');
      },
    });
    const result = await executeOp(
      driver,
      FAKE_HANDLE,
      { opId: 'r', op: 'readFile', args: { relPath: 'README.md' } },
      silentLogger,
    );
    expect(result).toEqual({ base64: Buffer.from('hello').toString('base64') });
  });

  it('writeFile: decodes base64 into a Buffer for driver.writeFile', async () => {
    const writeSpy = vi.fn(async () => undefined);
    const driver = makeFakeDriver({ writeFile: writeSpy });
    await executeOp(
      driver,
      FAKE_HANDLE,
      {
        opId: 'w',
        op: 'writeFile',
        args: { relPath: 'out.txt', base64: Buffer.from('world').toString('base64') },
      },
      silentLogger,
    );
    expect(writeSpy).toHaveBeenCalledTimes(1);
    const [, , data] = writeSpy.mock.calls[0]!;
    expect(Buffer.isBuffer(data)).toBe(true);
    expect((data as Buffer).toString()).toBe('world');
  });

  it('kill: passes the signal through', async () => {
    const killSpy = vi.fn(async () => undefined);
    const driver = makeFakeDriver({ kill: killSpy });
    await executeOp(
      driver,
      FAKE_HANDLE,
      { opId: 'k', op: 'kill', args: { signal: 'SIGKILL' } },
      silentLogger,
    );
    expect(killSpy).toHaveBeenCalledWith(FAKE_HANDLE, 'SIGKILL');
  });

  it('kill: tolerates missing signal arg', async () => {
    const killSpy = vi.fn(async () => undefined);
    const driver = makeFakeDriver({ kill: killSpy });
    await executeOp(
      driver,
      FAKE_HANDLE,
      { opId: 'k', op: 'kill', args: {} },
      silentLogger,
    );
    expect(killSpy).toHaveBeenCalledWith(FAKE_HANDLE, undefined);
  });

  it('stop: routes to driver.stop, returns ok envelope', async () => {
    const stopSpy = vi.fn(async () => undefined);
    const driver = makeFakeDriver({ stop: stopSpy });
    const result = await executeOp(
      driver,
      FAKE_HANDLE,
      { opId: 's', op: 'stop', args: {} },
      silentLogger,
    );
    expect(result).toEqual({ ok: true });
    expect(stopSpy).toHaveBeenCalledTimes(1);
  });

  it('exec without prior start: throws clear handle-required error', async () => {
    const driver = makeFakeDriver();
    await expect(
      executeOp(
        driver,
        null,
        { opId: 'e', op: 'exec', args: { cmd: 'noop', args: [] } },
        silentLogger,
      ),
    ).rejects.toThrow(/requires an active sandbox handle/);
  });

  it('readFile / writeFile / kill / stop all require a prior start', async () => {
    const driver = makeFakeDriver();
    for (const op of ['readFile', 'writeFile', 'kill', 'stop']) {
      await expect(
        executeOp(driver, null, { opId: 'x', op, args: {} }, silentLogger),
      ).rejects.toThrow(/requires an active sandbox handle/);
    }
  });

  it('unknown op: throws a clear unknown-op error', async () => {
    const driver = makeFakeDriver();
    await expect(
      executeOp(
        driver,
        FAKE_HANDLE,
        { opId: '?', op: 'frobnicate', args: {} },
        silentLogger,
      ),
    ).rejects.toThrow(/unknown sandbox op: frobnicate/);
  });
});
