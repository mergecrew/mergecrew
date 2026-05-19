import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { maybeBuildDevcontainer, type ExecFileAsync } from '../src/devcontainer-build.js';

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

type StubResponse = { stdout?: string; stderr?: string; rejectWith?: Error };

/** Compose a fake ExecFileAsync that records calls and replies from a script. */
function makeExecStub(handlers: Array<{
  match: (cmd: string, args: string[]) => boolean;
  reply: StubResponse;
}>): { calls: Array<{ cmd: string; args: string[] }>; fn: ExecFileAsync } {
  const calls: Array<{ cmd: string; args: string[] }> = [];
  const fn: ExecFileAsync = async (cmd, args) => {
    calls.push({ cmd, args });
    for (const h of handlers) {
      if (h.match(cmd, args)) {
        if (h.reply.rejectWith) throw h.reply.rejectWith;
        return { stdout: h.reply.stdout ?? '', stderr: h.reply.stderr ?? '' };
      }
    }
    return { stdout: '', stderr: '' };
  };
  return { calls, fn };
}

describe('maybeBuildDevcontainer', () => {
  let workspace: string;

  beforeEach(async () => {
    workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'devcontainer-test-'));
  });

  afterEach(async () => {
    await fs.rm(workspace, { recursive: true, force: true });
  });

  it('returns no_devcontainer when no config exists', async () => {
    const r = await maybeBuildDevcontainer({ workspacePath: workspace, logger });
    expect(r.kind).toBe('no_devcontainer');
  });

  it('returns built + image ref when devcontainer.json exists and CLI succeeds', async () => {
    await fs.mkdir(path.join(workspace, '.devcontainer'));
    await fs.writeFile(
      path.join(workspace, '.devcontainer', 'devcontainer.json'),
      JSON.stringify({ image: 'mcr.microsoft.com/devcontainers/javascript-node:20' }),
    );
    const { calls, fn } = makeExecStub([
      {
        match: (cmd, args) => cmd === 'docker' && args[0] === 'image' && args[1] === 'inspect',
        reply: { rejectWith: Object.assign(new Error('no such object'), { code: 1 }) },
      },
      {
        match: (cmd, args) => cmd === 'npx' && args.includes('@devcontainers/cli'),
        reply: { stdout: '' },
      },
    ]);
    const r = await maybeBuildDevcontainer({ workspacePath: workspace, logger, execFileAsync: fn });
    expect(r.kind).toBe('built');
    if (r.kind === 'built') {
      expect(r.image).toMatch(/^mergecrew-devcontainer:[a-f0-9]{16}$/);
    }
    expect(calls.some((c) => c.cmd === 'docker')).toBe(true);
    expect(calls.some((c) => c.cmd === 'npx')).toBe(true);
  });

  it('returns cached when docker image inspect succeeds', async () => {
    await fs.mkdir(path.join(workspace, '.devcontainer'));
    await fs.writeFile(
      path.join(workspace, '.devcontainer', 'devcontainer.json'),
      JSON.stringify({ image: 'foo' }),
    );
    const { fn } = makeExecStub([
      {
        match: (cmd, args) => cmd === 'docker' && args[0] === 'image' && args[1] === 'inspect',
        reply: { stdout: '[{"Id":"sha256:abc"}]' },
      },
    ]);
    const r = await maybeBuildDevcontainer({ workspacePath: workspace, logger, execFileAsync: fn });
    expect(r.kind).toBe('cached');
  });

  it('returns failed with a clean reason when npx fails', async () => {
    await fs.mkdir(path.join(workspace, '.devcontainer'));
    await fs.writeFile(
      path.join(workspace, '.devcontainer', 'devcontainer.json'),
      JSON.stringify({ image: 'foo' }),
    );
    const { fn } = makeExecStub([
      {
        match: (cmd) => cmd === 'docker',
        reply: { rejectWith: Object.assign(new Error('not cached'), { code: 1 }) },
      },
      {
        match: (cmd) => cmd === 'npx',
        reply: { rejectWith: Object.assign(new Error('devcontainer cli failed'), { code: 1, stderr: 'pull access denied' }) },
      },
    ]);
    const r = await maybeBuildDevcontainer({ workspacePath: workspace, logger, execFileAsync: fn });
    expect(r.kind).toBe('failed');
    if (r.kind === 'failed') expect(r.reason).toMatch(/devcontainer build failed/);
  });

  it('returns failed with ENOENT message when npx is not on PATH', async () => {
    await fs.mkdir(path.join(workspace, '.devcontainer'));
    await fs.writeFile(
      path.join(workspace, '.devcontainer', 'devcontainer.json'),
      '{}',
    );
    const { fn } = makeExecStub([
      {
        match: (cmd) => cmd === 'docker',
        reply: { rejectWith: Object.assign(new Error('not cached'), { code: 1 }) },
      },
      {
        match: (cmd) => cmd === 'npx',
        reply: { rejectWith: Object.assign(new Error('ENOENT'), { code: 'ENOENT' }) },
      },
    ]);
    const r = await maybeBuildDevcontainer({ workspacePath: workspace, logger, execFileAsync: fn });
    expect(r.kind).toBe('failed');
    if (r.kind === 'failed') expect(r.reason).toMatch(/not on PATH/);
  });

  it('image ref is keyed by SHA-256 of config so equivalent configs share cache', async () => {
    await fs.mkdir(path.join(workspace, '.devcontainer'));
    const cfg = JSON.stringify({ image: 'foo', features: { node: {} } });
    await fs.writeFile(path.join(workspace, '.devcontainer', 'devcontainer.json'), cfg);
    let seen: string | undefined;
    const fn: ExecFileAsync = async (cmd, args) => {
      if (cmd === 'docker' && args[0] === 'image' && args[1] === 'inspect') {
        seen = args[2];
        throw Object.assign(new Error('not cached'), { code: 1 });
      }
      if (cmd === 'npx') {
        return { stdout: '', stderr: '' };
      }
      return { stdout: '', stderr: '' };
    };
    await maybeBuildDevcontainer({ workspacePath: workspace, logger, execFileAsync: fn });
    expect(seen).toMatch(/^mergecrew-devcontainer:[a-f0-9]{16}$/);
  });
});
