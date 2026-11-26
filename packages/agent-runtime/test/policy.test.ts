import { describe, expect, it } from 'vitest';
import { PolicyEngine, minimatch, touchesDeploySensitivePaths } from '../src/policy.js';
import { READ_ONLY_KIND_NETWORK_PROBES } from '../src/loop.js';

const base = { agentDoNotTouch: [], projectSensitivePatterns: [], projectHardBlocked: ['**/.env*'] };

describe('commit gate evaluates the staged diff, not agent-supplied paths', () => {
  it('ignores declared paths when a staged-paths provider is wired', async () => {
    const policy = new PolicyEngine({ ...base, stagedPathsProvider: async () => ['src/a.ts', '.env.production'] });
    const d = await policy.checkCall('repo.git.commit', { message: 'x', paths: ['README.md'] });
    expect(d).toMatchObject({ ok: false, hard: true });
    expect(d.detail).toContain('.env.production');
  });

  it('a staged change outside declared paths that touches CI is gated', async () => {
    const policy = new PolicyEngine({ ...base, stagedPathsProvider: async () => ['.github/workflows/deploy.yml'] });
    const d = await policy.checkCall('repo.git.commit', { message: 'x', paths: [] });
    expect(d.ok).toBe(false);
    expect(d.reason).toBe('sensitive_path');
  });

  it('fails closed when the staged diff cannot be computed', async () => {
    const policy = new PolicyEngine({
      ...base,
      stagedPathsProvider: async () => {
        throw new Error('unsafe repo');
      },
    });
    expect(await policy.checkCall('repo.git.commit', { message: 'x' })).toMatchObject({ ok: false, hard: true });
  });

  it('clean staged diff passes', async () => {
    const policy = new PolicyEngine({ ...base, stagedPathsProvider: async () => ['src/a.ts'] });
    expect(await policy.checkCall('repo.git.commit', { message: 'x' })).toEqual({ ok: true });
  });
});

describe('default sensitive / hard-blocked paths', () => {
  const policy = new PolicyEngine({ ...base, projectHardBlocked: [] });
  it.each([
    '.github/workflows/ci.yml',
    './.github/workflows/ci.yml',
    '.github/actions/setup/action.yml',
    'Dockerfile',
    'apps/web/Dockerfile',
    'infra/docker/Dockerfile.runner',
    '.gitlab-ci.yml',
    '.circleci/config.yml',
    'Jenkinsfile',
    'infra/main.tf',
    'infra/prod.tfvars',
    'docker-compose.yml',
    '.devcontainer/devcontainer.json',
  ])('gates writes to %s', (p) => {
    const d = policy.check('repo.write_file', { path: p, content: '' });
    expect(d.ok, p).toBe(false);
  });

  it.each(['.git/config', '.git/hooks/pre-commit', '.gitmodules', 'lib/.gitattributes', '.env', 'apps/api/.env.local'])(
    'hard-blocks %s',
    (p) => {
      expect(policy.check('repo.write_file', { path: p, content: '' })).toMatchObject({ ok: false, hard: true });
    },
  );

  it('does not over-match ordinary files', () => {
    for (const p of ['src/DockerfileParser.ts', 'docs/terraform.md', 'src/oauth/callback.ts', 'README.md']) {
      expect(policy.check('repo.write_file', { path: p, content: '' }), p).toEqual({ ok: true });
    }
  });

  it('touchesDeploySensitivePaths reports workflow / Docker / IaC edits', () => {
    expect(touchesDeploySensitivePaths(['src/a.ts', '.github/workflows/deploy.yml', 'Dockerfile'])).toEqual([
      '.github/workflows/deploy.yml',
      'Dockerfile',
    ]);
    expect(touchesDeploySensitivePaths(['src/a.ts'])).toEqual([]);
  });

  it('`**/` matches whole segments only', () => {
    expect(minimatch('apps/auth/x.ts', '**/auth/**')).toBe(true);
    expect(minimatch('auth/x.ts', '**/auth/**')).toBe(true);
    expect(minimatch('apps/oauth/x.ts', '**/auth/**')).toBe(false);
  });
});

describe('irreversible skills', () => {
  it('deploy.prod is hard-rejected from the agent loop', async () => {
    const policy = new PolicyEngine(base);
    expect(await policy.checkCall('deploy.prod', { ref: 'main' })).toMatchObject({
      ok: false,
      hard: true,
      reason: 'production_promote',
    });
  });

  it('read-only probe exceptions do not include web.fetch_url', () => {
    expect(READ_ONLY_KIND_NETWORK_PROBES.has('web.fetch_url')).toBe(false);
  });
});
