import { promises as fs } from 'node:fs';
import path from 'node:path';

/**
 * Stack detection (#566 / #552 Option A). Reads lockfiles + manifests
 * in the workspace root and returns a `ProjectStack` describing how
 * the build skills should invoke install / typecheck / lint / test /
 * integration. The matrix is intentionally narrow — these are the
 * canonical commands per stack the cookbook documents. Projects with
 * one-off layouts override per skill via `mergecrew.yaml build.commands`.
 *
 * The "no detection signals" case returns `language: 'unknown'` with
 * every command `null`, which the build skills surface as
 * `not_configured` rather than `tests_fail`.
 */

export type Language =
  | 'node'
  | 'python'
  | 'go'
  | 'java'
  | 'php'
  | 'ruby'
  | 'rust'
  | 'dotnet'
  | 'unknown';

export type PackageManager =
  | 'npm'
  | 'pnpm'
  | 'yarn'
  | 'poetry'
  | 'uv'
  | 'pip'
  | 'go'
  | 'maven'
  | 'gradle'
  | 'composer'
  | 'bundler'
  | 'cargo'
  | 'dotnet'
  | 'none';

export interface BuildCommand {
  cmd: string;
  args: string[];
}

export interface StackCommands {
  install: BuildCommand | null;
  typecheck: BuildCommand | null;
  lint: BuildCommand | null;
  test: BuildCommand | null;
  integration: BuildCommand | null;
}

export interface ProjectStack {
  language: Language;
  packageManager: PackageManager;
  commands: StackCommands;
}

/**
 * Per-command overrides from `mergecrew.yaml build.commands.*`. Each
 * override fully replaces the detected command. Skill-level override
 * resolution: override → detected → null.
 */
export interface BuildCommandsOverride {
  install?: BuildCommand;
  typecheck?: BuildCommand;
  lint?: BuildCommand;
  test?: BuildCommand;
  integration?: BuildCommand;
}

/**
 * Look at the workspace and decide which stack to drive. Project
 * config overrides win per-command, even when detection succeeds.
 */
export async function detectStack(
  workspacePath: string,
  override?: BuildCommandsOverride,
): Promise<ProjectStack> {
  const has = await fileExistsMap(workspacePath, [
    'package.json',
    'pnpm-lock.yaml',
    'yarn.lock',
    'package-lock.json',
    'pyproject.toml',
    'poetry.lock',
    'uv.lock',
    'requirements.txt',
    'go.mod',
    'pom.xml',
    'build.gradle',
    'build.gradle.kts',
    'gradlew',
    'composer.json',
    'Gemfile',
    'Cargo.toml',
  ]);
  const detected = decide(has, workspacePath);
  if (!override) return detected;
  return {
    ...detected,
    commands: {
      install: override.install ?? detected.commands.install,
      typecheck: override.typecheck ?? detected.commands.typecheck,
      lint: override.lint ?? detected.commands.lint,
      test: override.test ?? detected.commands.test,
      integration: override.integration ?? detected.commands.integration,
    },
  };
}

function decide(has: Record<string, boolean>, workspacePath: string): ProjectStack {
  if (has['package.json']) return nodeStack(has);
  if (has['pyproject.toml'] || has['requirements.txt']) return pythonStack(has);
  if (has['go.mod']) return goStack();
  if (has['pom.xml']) return mavenStack();
  if (has['gradlew'] || has['build.gradle'] || has['build.gradle.kts']) return gradleStack(workspacePath);
  if (has['composer.json']) return phpStack();
  if (has['Gemfile']) return rubyStack();
  if (has['Cargo.toml']) return rustStack();
  return {
    language: 'unknown',
    packageManager: 'none',
    commands: { install: null, typecheck: null, lint: null, test: null, integration: null },
  };
}

function nodeStack(has: Record<string, boolean>): ProjectStack {
  const pm: PackageManager = has['pnpm-lock.yaml']
    ? 'pnpm'
    : has['yarn.lock']
      ? 'yarn'
      : 'npm';
  const install: BuildCommand =
    pm === 'pnpm'
      ? { cmd: 'pnpm', args: ['install', '--frozen-lockfile'] }
      : pm === 'yarn'
        ? { cmd: 'yarn', args: ['install', '--frozen-lockfile'] }
        : { cmd: 'npm', args: ['ci'] };
  return {
    language: 'node',
    packageManager: pm,
    commands: {
      install,
      typecheck: { cmd: pm, args: ['run', 'typecheck'] },
      lint: { cmd: pm, args: ['run', 'lint'] },
      test: { cmd: pm, args: ['run', 'test'] },
      integration: { cmd: pm, args: ['run', 'test:integration'] },
    },
  };
}

function pythonStack(has: Record<string, boolean>): ProjectStack {
  if (has['poetry.lock']) {
    return {
      language: 'python',
      packageManager: 'poetry',
      commands: {
        install: { cmd: 'poetry', args: ['install', '--no-interaction'] },
        typecheck: { cmd: 'poetry', args: ['run', 'mypy', '.'] },
        lint: { cmd: 'poetry', args: ['run', 'ruff', 'check', '.'] },
        test: { cmd: 'poetry', args: ['run', 'pytest'] },
        integration: null,
      },
    };
  }
  if (has['uv.lock']) {
    return {
      language: 'python',
      packageManager: 'uv',
      commands: {
        install: { cmd: 'uv', args: ['sync'] },
        typecheck: { cmd: 'uv', args: ['run', 'mypy', '.'] },
        lint: { cmd: 'uv', args: ['run', 'ruff', 'check', '.'] },
        test: { cmd: 'uv', args: ['run', 'pytest'] },
        integration: null,
      },
    };
  }
  return {
    language: 'python',
    packageManager: 'pip',
    commands: {
      install: { cmd: 'pip', args: ['install', '-r', 'requirements.txt'] },
      typecheck: { cmd: 'mypy', args: ['.'] },
      lint: { cmd: 'ruff', args: ['check', '.'] },
      test: { cmd: 'pytest', args: [] },
      integration: null,
    },
  };
}

function goStack(): ProjectStack {
  return {
    language: 'go',
    packageManager: 'go',
    commands: {
      install: { cmd: 'go', args: ['mod', 'download'] },
      // `go build ./...` doubles as a typecheck — type errors fail the build.
      typecheck: { cmd: 'go', args: ['build', './...'] },
      lint: { cmd: 'golangci-lint', args: ['run'] },
      test: { cmd: 'go', args: ['test', './...'] },
      integration: null,
    },
  };
}

function mavenStack(): ProjectStack {
  return {
    language: 'java',
    packageManager: 'maven',
    commands: {
      install: { cmd: 'mvn', args: ['-B', '-q', 'dependency:resolve'] },
      typecheck: { cmd: 'mvn', args: ['-B', '-q', 'compile'] },
      lint: { cmd: 'mvn', args: ['-B', '-q', 'spotless:check'] },
      test: { cmd: 'mvn', args: ['-B', '-q', 'test'] },
      integration: { cmd: 'mvn', args: ['-B', '-q', 'verify'] },
    },
  };
}

function gradleStack(workspacePath: string): ProjectStack {
  // Prefer the wrapper when present so the project pins its gradle.
  // The cmd here is a relative path that build.ts resolves against
  // the workspace at exec time.
  void workspacePath;
  return {
    language: 'java',
    packageManager: 'gradle',
    commands: {
      install: { cmd: './gradlew', args: ['dependencies'] },
      typecheck: { cmd: './gradlew', args: ['check', '-x', 'test'] },
      lint: { cmd: './gradlew', args: ['spotlessCheck'] },
      test: { cmd: './gradlew', args: ['test'] },
      integration: { cmd: './gradlew', args: ['integrationTest'] },
    },
  };
}

function phpStack(): ProjectStack {
  return {
    language: 'php',
    packageManager: 'composer',
    commands: {
      install: { cmd: 'composer', args: ['install', '--no-interaction'] },
      typecheck: { cmd: 'vendor/bin/phpstan', args: ['analyse'] },
      lint: { cmd: 'vendor/bin/phpcs', args: [] },
      test: { cmd: 'vendor/bin/phpunit', args: [] },
      integration: null,
    },
  };
}

function rubyStack(): ProjectStack {
  return {
    language: 'ruby',
    packageManager: 'bundler',
    commands: {
      install: { cmd: 'bundle', args: ['install'] },
      typecheck: null,
      lint: { cmd: 'bundle', args: ['exec', 'rubocop'] },
      test: { cmd: 'bundle', args: ['exec', 'rspec'] },
      integration: null,
    },
  };
}

function rustStack(): ProjectStack {
  return {
    language: 'rust',
    packageManager: 'cargo',
    commands: {
      install: { cmd: 'cargo', args: ['fetch'] },
      typecheck: { cmd: 'cargo', args: ['check'] },
      lint: { cmd: 'cargo', args: ['clippy', '--', '-D', 'warnings'] },
      test: { cmd: 'cargo', args: ['test'] },
      integration: null,
    },
  };
}

async function fileExistsMap(root: string, files: string[]): Promise<Record<string, boolean>> {
  const out: Record<string, boolean> = {};
  await Promise.all(
    files.map(async (name) => {
      try {
        await fs.access(path.join(root, name));
        out[name] = true;
      } catch {
        out[name] = false;
      }
    }),
  );
  return out;
}
