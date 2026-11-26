/**
 * Repo skills run in the supervisor process over attacker-controlled
 * workspaces. These tests plant symlinks / git metadata the way a
 * malicious tenant repo (or a sandboxed build step) would, and assert
 * nothing outside the workspace is ever read, listed or written.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ValidationError } from '@mergecrew/domain';
import { gitCommitAll, gitCreateBranch, gitCurrentBranch } from '@mergecrew/adapters-vcs';
import { SkillExecutor, stockSkills, type SkillExecutionContext } from '../src/index.js';
import { normalizeAgentBranchName, runBranchName } from '../src/stock/repo.js';

let base: string;
let ws: string;
let outside: string;
let other: string;
let exec: SkillExecutor;
let ctx: SkillExecutionContext;

function fixtureGit(args: string[], cwd: string): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      HOME: base,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_AUTHOR_NAME: 'f',
      GIT_AUTHOR_EMAIL: 'f@x.y',
      GIT_COMMITTER_NAME: 'f',
      GIT_COMMITTER_EMAIL: 'f@x.y',
    },
  });
}

const fakeVcs = {
  id: 'github',
  commit: (w: string, o: any) => gitCommitAll(w, o),
  createBranch: (w: string, n: string, f: string) => gitCreateBranch(w, n, f),
} as any;

beforeEach(async () => {
  base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mc-repo-sec-')));
  ws = path.join(base, 'work', 'run-1');
  other = path.join(base, 'work', 'run-2'); // another tenant's workspace
  outside = path.join(base, 'app'); // stands in for /app (runner code)
  await fs.mkdir(ws, { recursive: true });
  await fs.mkdir(other, { recursive: true });
  await fs.mkdir(outside, { recursive: true });
  await fs.writeFile(path.join(other, 'secrets.env'), 'OTHER_TENANT_SECRET=1');
  await fs.writeFile(path.join(outside, 'main.js'), 'runner code');
  await fs.writeFile(path.join(ws, 'README.md'), 'hello');
  exec = new SkillExecutor();
  exec.registerAll(stockSkills);
  ctx = {
    organizationId: 'org',
    projectId: 'proj',
    runId: 'run-1',
    workspacePath: ws,
    abortSignal: new AbortController().signal,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    adapters: { vcs: fakeVcs },
  };
});

afterEach(async () => {
  await fs.rm(base, { recursive: true, force: true });
});

describe('symlink escapes', () => {
  const plants: Array<[string, () => Promise<void>, string]> = [
    ['symlink to /proc/self/environ', () => fs.symlink('/proc/self/environ', path.join(ws, 'env.txt')), 'env.txt'],
    ['symlink to /etc/passwd', () => fs.symlink('/etc/passwd', path.join(ws, 'passwd')), 'passwd'],
    ['relative symlink to another tenant', () => fs.symlink('../run-2/secrets.env', path.join(ws, 'peek')), 'peek'],
    ['symlinked dir to runner code', () => fs.symlink(outside, path.join(ws, 'vendor')), 'vendor/main.js'],
    ['nested dir symlink chain', async () => {
      await fs.mkdir(path.join(ws, 'a/b'), { recursive: true });
      await fs.symlink('../../hop', path.join(ws, 'a/b/c'));
      await fs.symlink('../run-2', path.join(ws, 'hop'));
    }, 'a/b/c/secrets.env'],
  ];

  for (const [name, plant, rel] of plants) {
    it(`repo.read_file refuses ${name}`, async () => {
      await plant();
      await expect(exec.execute('repo.read_file', { path: rel }, ctx)).rejects.toThrow();
    });
  }

  it('repo.write_file never writes through a symlink (file or directory)', async () => {
    await fs.symlink(path.join(outside, 'main.js'), path.join(ws, 'index.js'));
    await expect(exec.execute('repo.write_file', { path: 'index.js', content: 'pwned' }, ctx)).rejects.toBeInstanceOf(ValidationError);
    await fs.symlink(outside, path.join(ws, 'vendor'));
    await expect(exec.execute('repo.write_file', { path: 'vendor/main.js', content: 'pwned' }, ctx)).rejects.toBeInstanceOf(ValidationError);
    await expect(exec.execute('repo.write_file', { path: 'vendor/new/x.js', content: 'pwned' }, ctx)).rejects.toBeInstanceOf(ValidationError);
    await fs.symlink('../run-2', path.join(ws, 'peer'));
    await expect(exec.execute('repo.write_file', { path: 'peer/secrets.env', content: 'pwned' }, ctx)).rejects.toBeInstanceOf(ValidationError);
    expect(await fs.readFile(path.join(outside, 'main.js'), 'utf8')).toBe('runner code');
    expect(await fs.readFile(path.join(other, 'secrets.env'), 'utf8')).toBe('OTHER_TENANT_SECRET=1');
    await expect(fs.access(path.join(outside, 'new'))).rejects.toThrow();
  });

  it('repo.list_paths does not traverse or report symlinks', async () => {
    await fs.symlink(outside, path.join(ws, 'vendor'));
    await fs.symlink('../run-2/secrets.env', path.join(ws, 'peek'));
    const r: any = await exec.execute('repo.list_paths', {}, ctx);
    expect(r.output.paths).toEqual(['README.md']);
    await expect(exec.execute('repo.list_paths', { dir: 'vendor' }, ctx)).rejects.toBeInstanceOf(ValidationError);
    await expect(exec.execute('repo.list_paths', { dir: '../run-2' }, ctx)).rejects.toBeInstanceOf(ValidationError);
  });

  it('repo.search never reads through symlinks', async () => {
    await fs.symlink(outside, path.join(ws, 'vendor'));
    await fs.symlink('../run-2/secrets.env', path.join(ws, 'peek'));
    const r1: any = await exec.execute('repo.search', { query: 'OTHER_TENANT_SECRET' }, ctx);
    expect(r1.output.matches).toEqual([]);
    const r2: any = await exec.execute('repo.search', { query: 'runner code' }, ctx);
    expect(r2.output.matches).toEqual([]);
    const r3: any = await exec.execute('repo.search', { query: 'hello' }, ctx);
    expect(r3.output.matches).toEqual([{ path: 'README.md', line: 1, preview: 'hello' }]);
  });
});

describe('git metadata is off-limits to agent file skills', () => {
  beforeEach(() => {
    fixtureGit(['init', '-q', '-b', 'main'], ws);
    fixtureGit(['add', '-A'], ws);
    fixtureGit(['commit', '-q', '-m', 'init'], ws);
  });

  for (const p of ['.git/config', '.git/hooks/pre-commit', '.git/info/attributes', '.gitmodules', '.gitattributes', 'sub/.gitattributes', '.GIT/config', 'nested/.git/config']) {
    it(`repo.write_file refuses ${p}`, async () => {
      await expect(exec.execute('repo.write_file', { path: p, content: '[core]\n\tfsmonitor = /bin/sh' }, ctx)).rejects.toThrow(/git metadata/);
    });
  }

  it('repo.read_file refuses .git/config (and via an in-repo symlink)', async () => {
    await expect(exec.execute('repo.read_file', { path: '.git/config' }, ctx)).rejects.toThrow(/git metadata/);
    await fs.symlink('.git', path.join(ws, 'meta'));
    await expect(exec.execute('repo.read_file', { path: 'meta/config' }, ctx)).rejects.toThrow(/git metadata/);
  });
});

describe('repo.git.commit / create_branch', () => {
  beforeEach(() => {
    fixtureGit(['init', '-q', '-b', 'main'], ws);
    fixtureGit(['add', '-A'], ws);
    fixtureGit(['commit', '-q', '-m', 'init'], ws);
  });

  it('never commits on the default branch: moves HEAD to mergecrew/<run-id> first', async () => {
    await fs.writeFile(path.join(ws, 'a.ts'), 'x');
    const r: any = await exec.execute('repo.git.commit', { message: 'feat: a' }, ctx);
    expect(r.output.branch).toBe('mergecrew/run-1');
    expect(fixtureGit(['rev-list', '--count', 'main'], ws).trim()).toBe('1');
  });

  it('commit gate sees the real staged diff, not agent-declared paths', async () => {
    await fs.mkdir(path.join(ws, '.github/workflows'), { recursive: true });
    await fs.writeFile(path.join(ws, '.github/workflows/deploy.yml'), 'on: push');
    const seen: string[][] = [];
    ctx.config = {
      commitGuard: (paths: string[]) => {
        seen.push(paths);
        if (paths.some((p) => p.startsWith('.github/'))) throw new ValidationError('blocked: workflow edit');
      },
    };
    await expect(
      exec.execute('repo.git.commit', { message: 'docs', paths: ['README.md'] }, ctx),
    ).rejects.toThrow(/workflow edit/);
    expect(seen[0]).toEqual(['.github/workflows/deploy.yml']);
  });

  it('create_branch namespaces names and rejects option injection in name/from', async () => {
    const r: any = await exec.execute('repo.git.create_branch', { name: 'feat/login' }, ctx);
    expect(r.output.branch).toBe('mergecrew/feat/login');
    expect(await gitCurrentBranch(ws)).toBe('mergecrew/feat/login');
    await expect(exec.execute('repo.git.create_branch', { name: '--orphan' }, ctx)).rejects.toThrow();
    await expect(exec.execute('repo.git.create_branch', { name: 'x', from: '--upload-pack=sh' }, ctx)).rejects.toBeInstanceOf(ValidationError);
    await expect(exec.execute('repo.git.create_branch', { name: 'y', from: 'nope' }, ctx)).rejects.toThrow(/unknown start point/);
  });

  it('helpers', () => {
    expect(runBranchName('abc/../x')).toBe('mergecrew/abc----x');
    expect(runBranchName(undefined)).toBe('mergecrew/run');
    expect(normalizeAgentBranchName('mergecrew/x')).toBe('mergecrew/x');
    expect(() => normalizeAgentBranchName('a..b')).toThrow(ValidationError);
  });
});
