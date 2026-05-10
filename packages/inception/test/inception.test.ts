import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { detectStack, buildDraftYaml, runInception } from '../src/index.js';

let workspace: string;

beforeEach(async () => {
  workspace = await mkdtemp(path.join(tmpdir(), 'mergecrew-inception-'));
});

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true }).catch(() => {});
});

async function write(rel: string, body: string): Promise<void> {
  const full = path.join(workspace, rel);
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, body, 'utf8');
}

describe('detectStack', () => {
  it('returns empty summary for an empty workspace', async () => {
    const s = await detectStack(workspace);
    expect(s.frameworks).toEqual([]);
    expect(s.scripts).toEqual([]);
    expect(s.workflows).toEqual([]);
  });

  it('detects Next.js + React + Prisma + TypeScript from a typical webapp', async () => {
    await write(
      'package.json',
      JSON.stringify({
        name: 'demo',
        dependencies: {
          next: '^16.0.0',
          react: '^19.0.0',
          '@prisma/client': '^5.22.0',
        },
        devDependencies: { typescript: '^5.6.2' },
        scripts: {
          dev: 'next dev',
          build: 'next build',
          test: 'vitest run',
          lint: 'eslint .',
          typecheck: 'tsc --noEmit',
        },
      }),
    );
    await write('tsconfig.json', '{}');

    const s = await detectStack(workspace);
    const kinds = s.frameworks.map((f) => f.kind).sort();
    expect(kinds).toEqual(['nextjs', 'prisma', 'react', 'typescript'].sort());
    const next = s.frameworks.find((f) => f.kind === 'nextjs');
    expect(next?.version).toBe('16.0.0');
  });

  it('classifies package.json scripts by kind', async () => {
    await write(
      'package.json',
      JSON.stringify({
        scripts: {
          dev: 'next dev',
          build: 'next build',
          test: 'vitest run',
          'test:e2e': 'playwright test',
          lint: 'eslint .',
          typecheck: 'tsc --noEmit',
          random: 'echo hi',
        },
      }),
    );
    const s = await detectStack(workspace);
    const byName = Object.fromEntries(s.scripts.map((x) => [x.name, x.kind]));
    expect(byName.dev).toBe('dev');
    expect(byName.build).toBe('build');
    expect(byName.test).toBe('test');
    expect(byName['test:e2e']).toBe('test');
    expect(byName.lint).toBe('lint');
    expect(byName.typecheck).toBe('typecheck');
    expect(byName.random).toBe('unknown');
  });

  it('detects deploy-candidate workflows and surfaces them first', async () => {
    await write(
      '.github/workflows/ci.yml',
      'name: ci\non:\n  pull_request:\n    branches: [main]\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps: []\n',
    );
    await write(
      '.github/workflows/deploy-dev.yml',
      `name: deploy-dev
on:
  workflow_dispatch:
    inputs:
      branch:
        type: string
      mergecrew_correlation_id:
        type: string
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps: []
`,
    );

    const s = await detectStack(workspace);
    expect(s.workflows.length).toBe(2);
    // Deploy candidate is sorted first.
    expect(s.workflows[0]?.path).toContain('deploy-dev.yml');
    expect(s.workflows[0]?.isDeployCandidate).toBe(true);
    expect(s.workflows[0]?.acceptsCorrelationId).toBe(true);
    expect(s.workflows[1]?.isDeployCandidate).toBe(false);
  });

  it('flags workflows that lack the mergecrew_correlation_id input', async () => {
    await write(
      '.github/workflows/deploy.yml',
      `name: deploy
on:
  workflow_dispatch:
    inputs:
      branch:
        type: string
jobs: { x: { runs-on: ubuntu-latest, steps: [] } }
`,
    );
    const s = await detectStack(workspace);
    expect(s.workflows[0]?.acceptsCorrelationId).toBe(false);
  });

  it('detects Docker via Dockerfile or docker-compose.yml', async () => {
    await write('Dockerfile', 'FROM node:22\n');
    const s = await detectStack(workspace);
    const docker = s.frameworks.find((f) => f.kind === 'docker');
    expect(docker?.evidence).toBe('Dockerfile');
  });

  it('handles malformed workflow yaml without crashing', async () => {
    await write('.github/workflows/broken.yml', '::: not yaml :::');
    const s = await detectStack(workspace);
    expect(s.workflows).toEqual([]);
  });
});

describe('buildDraftYaml', () => {
  it('embeds detected frameworks in the header comment', async () => {
    const yaml = buildDraftYaml({
      frameworks: [
        { kind: 'nextjs', label: 'Next.js 16.0.0', version: '16.0.0', evidence: 'package.json' },
        { kind: 'typescript', label: 'TypeScript', evidence: 'tsconfig.json' },
      ],
      scripts: [],
      workflows: [],
    });
    expect(yaml).toContain('Project Inception summary');
    expect(yaml).toContain('Next.js 16.0.0');
    expect(yaml).toContain('TypeScript');
    // Default lifecycle is appended below the header.
    expect(yaml).toContain('lifecycle:');
    expect(yaml).toContain('discovery');
  });

  it('lists deploy-candidate workflows separately from generic CI', async () => {
    const yaml = buildDraftYaml({
      frameworks: [],
      scripts: [],
      workflows: [
        { path: '.github/workflows/deploy-dev.yml', events: ['workflow_dispatch'], isDeployCandidate: true, acceptsCorrelationId: true },
        { path: '.github/workflows/ci.yml', events: ['pull_request'], isDeployCandidate: false, acceptsCorrelationId: false },
      ],
    });
    expect(yaml).toContain('Deploy-workflow candidates');
    expect(yaml).toContain('deploy-dev.yml');
    expect(yaml).not.toContain('ci.yml'); // generic ci is not surfaced as a deploy candidate
  });

  it('warns when a deploy candidate lacks the correlation-id input', async () => {
    const yaml = buildDraftYaml({
      frameworks: [],
      scripts: [],
      workflows: [
        { path: '.github/workflows/deploy.yml', events: ['workflow_dispatch'], isDeployCandidate: true, acceptsCorrelationId: false },
      ],
    });
    expect(yaml).toContain('NO mergecrew_correlation_id input');
  });
});

describe('runInception', () => {
  it('produces both summary and draft yaml in one call', async () => {
    await write('package.json', JSON.stringify({ dependencies: { next: '^16.0.0' } }));
    const r = await runInception(workspace);
    expect(r.summary.frameworks.some((f) => f.kind === 'nextjs')).toBe(true);
    expect(r.draftYaml).toContain('Next.js');
    expect(r.draftYaml).toContain('lifecycle:');
  });
});
