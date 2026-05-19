import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { detectStack } from '../src/stock/detect-stack.js';

async function touch(dir: string, ...files: string[]): Promise<void> {
  await Promise.all(files.map((f) => fs.writeFile(path.join(dir, f), '')));
}

describe('detectStack', () => {
  let workspace: string;

  beforeEach(async () => {
    workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'stack-test-'));
  });

  afterEach(async () => {
    await fs.rm(workspace, { recursive: true, force: true });
  });

  it('returns "unknown" with all-null commands for an empty workspace', async () => {
    const s = await detectStack(workspace);
    expect(s.language).toBe('unknown');
    expect(s.packageManager).toBe('none');
    expect(Object.values(s.commands).every((c) => c === null)).toBe(true);
  });

  it('Node + pnpm lockfile → pnpm commands', async () => {
    await touch(workspace, 'package.json', 'pnpm-lock.yaml');
    const s = await detectStack(workspace);
    expect(s.language).toBe('node');
    expect(s.packageManager).toBe('pnpm');
    expect(s.commands.install).toEqual({ cmd: 'pnpm', args: ['install', '--frozen-lockfile'] });
    expect(s.commands.test).toEqual({ cmd: 'pnpm', args: ['run', 'test'] });
  });

  it('Node + yarn lockfile → yarn commands', async () => {
    await touch(workspace, 'package.json', 'yarn.lock');
    const s = await detectStack(workspace);
    expect(s.packageManager).toBe('yarn');
    expect(s.commands.install).toEqual({ cmd: 'yarn', args: ['install', '--frozen-lockfile'] });
  });

  it('Node + npm only → npm ci', async () => {
    await touch(workspace, 'package.json', 'package-lock.json');
    const s = await detectStack(workspace);
    expect(s.packageManager).toBe('npm');
    expect(s.commands.install).toEqual({ cmd: 'npm', args: ['ci'] });
  });

  it('Python + poetry lockfile → poetry commands', async () => {
    await touch(workspace, 'pyproject.toml', 'poetry.lock');
    const s = await detectStack(workspace);
    expect(s.language).toBe('python');
    expect(s.packageManager).toBe('poetry');
    expect(s.commands.test).toEqual({ cmd: 'poetry', args: ['run', 'pytest'] });
  });

  it('Python + uv lockfile → uv commands', async () => {
    await touch(workspace, 'pyproject.toml', 'uv.lock');
    const s = await detectStack(workspace);
    expect(s.packageManager).toBe('uv');
    expect(s.commands.lint).toEqual({ cmd: 'uv', args: ['run', 'ruff', 'check', '.'] });
  });

  it('Python + requirements.txt only → pip commands', async () => {
    await touch(workspace, 'requirements.txt');
    const s = await detectStack(workspace);
    expect(s.packageManager).toBe('pip');
    expect(s.commands.install).toEqual({ cmd: 'pip', args: ['install', '-r', 'requirements.txt'] });
  });

  it('Go module → go commands', async () => {
    await touch(workspace, 'go.mod');
    const s = await detectStack(workspace);
    expect(s.language).toBe('go');
    expect(s.commands.test).toEqual({ cmd: 'go', args: ['test', './...'] });
    expect(s.commands.lint).toEqual({ cmd: 'golangci-lint', args: ['run'] });
  });

  it('Maven (pom.xml) → mvn commands', async () => {
    await touch(workspace, 'pom.xml');
    const s = await detectStack(workspace);
    expect(s.language).toBe('java');
    expect(s.packageManager).toBe('maven');
    expect(s.commands.install).toEqual({ cmd: 'mvn', args: ['-B', '-q', 'dependency:resolve'] });
  });

  it('Gradle wrapper → ./gradlew commands', async () => {
    await touch(workspace, 'gradlew', 'build.gradle');
    const s = await detectStack(workspace);
    expect(s.packageManager).toBe('gradle');
    expect(s.commands.test).toEqual({ cmd: './gradlew', args: ['test'] });
  });

  it('PHP (Composer) → composer commands', async () => {
    await touch(workspace, 'composer.json');
    const s = await detectStack(workspace);
    expect(s.language).toBe('php');
    expect(s.commands.test).toEqual({ cmd: 'vendor/bin/phpunit', args: [] });
  });

  it('Ruby (Bundler) → bundle commands', async () => {
    await touch(workspace, 'Gemfile');
    const s = await detectStack(workspace);
    expect(s.language).toBe('ruby');
    expect(s.commands.test).toEqual({ cmd: 'bundle', args: ['exec', 'rspec'] });
    expect(s.commands.typecheck).toBeNull();
  });

  it('Rust (Cargo) → cargo commands', async () => {
    await touch(workspace, 'Cargo.toml');
    const s = await detectStack(workspace);
    expect(s.language).toBe('rust');
    expect(s.commands.lint).toEqual({ cmd: 'cargo', args: ['clippy', '--', '-D', 'warnings'] });
  });

  it('override fully replaces detected commands', async () => {
    await touch(workspace, 'package.json');
    const s = await detectStack(workspace, {
      test: { cmd: 'make', args: ['test'] },
    });
    expect(s.language).toBe('node');
    expect(s.commands.test).toEqual({ cmd: 'make', args: ['test'] });
    // Untouched commands keep their detected value.
    expect(s.commands.install).toEqual({ cmd: 'npm', args: ['ci'] });
  });

  it('override applies even when detection returns unknown', async () => {
    const s = await detectStack(workspace, {
      install: { cmd: 'make', args: ['setup'] },
      test: { cmd: 'make', args: ['test'] },
    });
    expect(s.language).toBe('unknown');
    expect(s.commands.install).toEqual({ cmd: 'make', args: ['setup'] });
    expect(s.commands.test).toEqual({ cmd: 'make', args: ['test'] });
    // Non-overridden commands stay null.
    expect(s.commands.lint).toBeNull();
  });
});
