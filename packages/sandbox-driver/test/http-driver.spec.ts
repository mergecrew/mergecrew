import { describe, expect, it } from 'vitest';
import { HttpSandboxDriver } from '../src/http-driver.js';
import type { SandboxHandle } from '../src/types.js';

/**
 * Unit tests for the HttpSandboxDriver class (ADR-0009). The driver
 * is transport-agnostic — it only knows how to marshal SandboxDriver
 * methods into HTTP POSTs. Tests use a fake fetcher to assert the
 * wire shape; no real agent or mediator required.
 */

interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

function makeFakeFetcher(
  responder: (call: RecordedCall) => { status?: number; body: unknown },
): { fetcher: typeof fetch; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input.toString();
    const headers = Object.fromEntries(
      Object.entries((init?.headers ?? {}) as Record<string, string>),
    );
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const call: RecordedCall = {
      url,
      method: (init?.method ?? 'GET').toUpperCase(),
      headers,
      body,
    };
    calls.push(call);
    const r = responder(call);
    return new Response(JSON.stringify(r.body), {
      status: r.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { fetcher, calls };
}

const FAKE_HANDLE: SandboxHandle = {
  id: 'sandbox-1',
  driver: 'http',
  workspacePath: '/work',
};

describe('HttpSandboxDriver — construction', () => {
  it('throws if baseUrl is missing', () => {
    expect(() => new HttpSandboxDriver({ baseUrl: '', authToken: 't', stepId: 's' })).toThrow(
      /baseUrl/,
    );
  });
  it('throws if authToken is missing', () => {
    expect(() => new HttpSandboxDriver({ baseUrl: 'http://x', authToken: '', stepId: 's' })).toThrow(
      /authToken/,
    );
  });
  it('throws if stepId is missing', () => {
    expect(() => new HttpSandboxDriver({ baseUrl: 'http://x', authToken: 't', stepId: '' })).toThrow(
      /stepId/,
    );
  });
  it('trims trailing slash from baseUrl', async () => {
    const { fetcher, calls } = makeFakeFetcher(() => ({ body: { ok: true, result: { ok: true } } }));
    const d = new HttpSandboxDriver({
      baseUrl: 'http://api/',
      authToken: 't',
      stepId: 's',
      fetcher,
    });
    await d.stop(FAKE_HANDLE);
    expect(calls[0]!.url).toBe('http://api/v1/runner-agent/sandbox-ops/s/stop');
  });
});

describe('HttpSandboxDriver — op marshaling', () => {
  it('start posts to /sandbox-ops/<stepId>/start and parses HandleEnvelope', async () => {
    const { fetcher, calls } = makeFakeFetcher(() => ({
      body: {
        ok: true,
        result: { id: 'h1', driver: 'http', workspacePath: '/work' },
      },
    }));
    const d = new HttpSandboxDriver({
      baseUrl: 'http://api',
      authToken: 'tok',
      stepId: 'step-1',
      fetcher,
    });
    const h = await d.start({
      runId: 'r',
      projectId: 'p',
      organizationId: 'o',
      workspacePath: '/host/work',
    });
    expect(h).toEqual({ id: 'h1', driver: 'http', workspacePath: '/work' });
    expect(calls[0]!.url).toBe('http://api/v1/runner-agent/sandbox-ops/step-1/start');
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.headers.authorization).toBe('Bearer tok');
    expect((calls[0]!.body as any).runId).toBe('r');
  });

  it('exec posts the ExecOpts subset (cmd, args, cwd, env, timeoutMs)', async () => {
    const { fetcher, calls } = makeFakeFetcher(() => ({
      body: {
        ok: true,
        result: { exitCode: 0, stdout: 'ok', stderr: '', timedOut: false, signal: null },
      },
    }));
    const d = new HttpSandboxDriver({
      baseUrl: 'http://api',
      authToken: 'tok',
      stepId: 'step-1',
      fetcher,
    });
    const r = await d.exec(FAKE_HANDLE, {
      cmd: 'npm',
      args: ['test'],
      cwd: 'pkg/x',
      env: { CI: '1' },
      timeoutMs: 60_000,
    });
    expect(r.exitCode).toBe(0);
    expect(calls[0]!.url).toBe('http://api/v1/runner-agent/sandbox-ops/step-1/exec');
    expect(calls[0]!.body).toEqual({
      cmd: 'npm',
      args: ['test'],
      cwd: 'pkg/x',
      env: { CI: '1' },
      timeoutMs: 60_000,
    });
  });

  it('readFile decodes base64 to Buffer', async () => {
    const { fetcher } = makeFakeFetcher(() => ({
      body: { ok: true, result: { base64: Buffer.from('hello').toString('base64') } },
    }));
    const d = new HttpSandboxDriver({
      baseUrl: 'http://api',
      authToken: 'tok',
      stepId: 'step-1',
      fetcher,
    });
    const buf = await d.readFile(FAKE_HANDLE, 'README.md');
    expect(buf.toString()).toBe('hello');
  });

  it('writeFile encodes Buffer to base64', async () => {
    const { fetcher, calls } = makeFakeFetcher(() => ({ body: { ok: true, result: { ok: true } } }));
    const d = new HttpSandboxDriver({
      baseUrl: 'http://api',
      authToken: 'tok',
      stepId: 'step-1',
      fetcher,
    });
    await d.writeFile(FAKE_HANDLE, 'out.txt', Buffer.from('world'));
    expect((calls[0]!.body as any).base64).toBe(Buffer.from('world').toString('base64'));
  });

  it('writeFile encodes string to base64', async () => {
    const { fetcher, calls } = makeFakeFetcher(() => ({ body: { ok: true, result: { ok: true } } }));
    const d = new HttpSandboxDriver({
      baseUrl: 'http://api',
      authToken: 'tok',
      stepId: 'step-1',
      fetcher,
    });
    await d.writeFile(FAKE_HANDLE, 'out.txt', 'world');
    expect((calls[0]!.body as any).base64).toBe(Buffer.from('world').toString('base64'));
  });

  it('kill posts the signal', async () => {
    const { fetcher, calls } = makeFakeFetcher(() => ({ body: { ok: true, result: { ok: true } } }));
    const d = new HttpSandboxDriver({
      baseUrl: 'http://api',
      authToken: 'tok',
      stepId: 'step-1',
      fetcher,
    });
    await d.kill(FAKE_HANDLE, 'SIGKILL');
    expect((calls[0]!.body as any).signal).toBe('SIGKILL');
  });

  it('encodes special characters in stepId', async () => {
    const { fetcher, calls } = makeFakeFetcher(() => ({ body: { ok: true, result: { ok: true } } }));
    const d = new HttpSandboxDriver({
      baseUrl: 'http://api',
      authToken: 'tok',
      stepId: 'a/b c',
      fetcher,
    });
    await d.stop(FAKE_HANDLE);
    expect(calls[0]!.url).toBe('http://api/v1/runner-agent/sandbox-ops/a%2Fb%20c/stop');
  });
});

describe('HttpSandboxDriver — error envelopes', () => {
  it('rejects on HTTP non-2xx', async () => {
    const { fetcher } = makeFakeFetcher(() => ({
      status: 500,
      body: { error: 'boom' },
    }));
    const d = new HttpSandboxDriver({
      baseUrl: 'http://api',
      authToken: 'tok',
      stepId: 'step-1',
      fetcher,
    });
    await expect(d.stop(FAKE_HANDLE)).rejects.toThrow(/500/);
  });

  it('rejects on envelope with ok=false, surfaces error.message', async () => {
    const { fetcher } = makeFakeFetcher(() => ({
      body: { ok: false, error: { message: 'agent disconnected', kind: 'agent_gone' } },
    }));
    const d = new HttpSandboxDriver({
      baseUrl: 'http://api',
      authToken: 'tok',
      stepId: 'step-1',
      fetcher,
    });
    await expect(d.stop(FAKE_HANDLE)).rejects.toThrow(/agent disconnected/);
  });

  it('rejects on empty result envelope', async () => {
    const { fetcher } = makeFakeFetcher(() => ({ body: { ok: true } }));
    const d = new HttpSandboxDriver({
      baseUrl: 'http://api',
      authToken: 'tok',
      stepId: 'step-1',
      fetcher,
    });
    await expect(d.stop(FAKE_HANDLE)).rejects.toThrow(/empty result/);
  });
});

describe('HttpSandboxDriver — name', () => {
  it('reports "http" as its driver name (for telemetry)', () => {
    const d = new HttpSandboxDriver({
      baseUrl: 'http://api',
      authToken: 'tok',
      stepId: 'step-1',
    });
    expect(d.name).toBe('http');
  });
});
