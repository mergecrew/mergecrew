import { ValidationError } from '@mergecrew/domain';
import type { AnySkill, SkillExecutionContext } from '../types.js';
import { detectStack, type BuildCommand, type BuildCommandsOverride } from './detect-stack.js';

/**
 * Build commands the runner is allowed to invoke. Each entry is a
 * literal command name (or a workspace-relative wrapper path like
 * `./gradlew`). Anything that needs to be installed by a stack image
 * — `mvn`, `gradle` via the gradlew wrapper, `poetry`, `cargo`,
 * etc. — is listed here once the runner-* image catalog ships it
 * (#567). Until then the docker driver pulls a polyglot base image
 * (#558 for node; later #567 for the others).
 *
 * Custom commands from `mergecrew.yaml build.commands` are validated
 * against this list — that's the gate that prevents the LLM from
 * naming an arbitrary binary.
 */
const ALLOWLIST_CMDS = new Set([
  // Node / TS
  'npm', 'pnpm', 'yarn',
  'node', 'tsc', 'tsx',
  'eslint', 'prettier',
  'jest', 'vitest', 'playwright',
  // Python
  'python', 'python3',
  'pip', 'pip3',
  'poetry', 'uv',
  'mypy', 'ruff', 'pytest', 'black',
  // Go
  'go', 'golangci-lint',
  // Java
  'mvn', 'gradle',
  // PHP
  'composer', 'php',
  // Ruby
  'bundle', 'ruby',
  // Rust
  'cargo',
  // .NET
  'dotnet',
  // Misc utilities used by stack defaults
  'sh', 'bash', 'make',
]);

/** Wrapper scripts shipped inside a project repo are allowed by prefix. */
const WRAPPER_PREFIXES = ['./gradlew', './mvnw', './scripts/'];

function isAllowedCommand(cmd: string): boolean {
  if (ALLOWLIST_CMDS.has(cmd)) return true;
  return WRAPPER_PREFIXES.some((p) => cmd.startsWith(p));
}

interface RunOpts {
  cmd: string;
  args: string[];
  ctx: SkillExecutionContext;
  timeoutMs?: number;
}

interface BuildSkillResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/**
 * "Not configured" sentinel returned when stack detection can't find
 * a command (e.g., a Go project with no lint target, or a freshly
 * scaffolded repo with no test script). The runner's QA verdict
 * parser (#566) treats this as `tests_skipped` rather than `tests_fail`
 * so empty projects don't burn the loop cap trying to fix a problem
 * that isn't a regression.
 */
interface NotConfiguredResult {
  notConfigured: true;
  reason: string;
}

type SkillOutput = BuildSkillResult | NotConfiguredResult;

async function runCommand(opts: RunOpts): Promise<BuildSkillResult> {
  if (!isAllowedCommand(opts.cmd)) {
    throw new ValidationError(`command not allowed: ${opts.cmd}`);
  }
  const { driver, sandbox } = opts.ctx;
  if (!driver || !sandbox) {
    throw new ValidationError(
      'build.*: sandbox driver not configured — the runner supervisor must call driver.start() before executing build skills',
    );
  }
  const r = await driver.exec(sandbox, {
    cmd: opts.cmd,
    args: opts.args,
    env: { CI: 'true', FORCE_COLOR: '0' },
    timeoutMs: opts.timeoutMs ?? 600_000,
    signal: opts.ctx.abortSignal,
  });
  return {
    exitCode: r.exitCode,
    stdout: tail(r.stdout, 8000),
    stderr: tail(r.stderr, 8000),
    timedOut: r.timedOut,
  };
}

function tail(s: string, max: number): string {
  return s.length <= max ? s : s.slice(s.length - max);
}

/**
 * Resolve the override block from the project's lifecycle config
 * (`build.commands`). Pulled from `ctx.config.build?.commands` which
 * the runner injects before each skill call.
 */
function overrideFromCtx(ctx: SkillExecutionContext): BuildCommandsOverride | undefined {
  const cfg = ctx.config?.build as { commands?: BuildCommandsOverride } | undefined;
  return cfg?.commands;
}

async function runStackCommand(
  ctx: SkillExecutionContext,
  pick: (cmds: Awaited<ReturnType<typeof detectStack>>['commands']) => BuildCommand | null,
  label: string,
): Promise<{ output: SkillOutput; brief: string }> {
  if (!ctx.workspacePath) throw new ValidationError('workspacePath required');
  const stack = await detectStack(ctx.workspacePath, overrideFromCtx(ctx));
  const cmd = pick(stack.commands);
  if (!cmd) {
    const reason =
      stack.language === 'unknown'
        ? `${label}: no recognized stack signals (package.json / pyproject.toml / go.mod / pom.xml / …)`
        : `${label}: no command for ${stack.language}/${stack.packageManager}`;
    return {
      output: { notConfigured: true, reason },
      brief: `${label}: not configured (${stack.language}/${stack.packageManager})`,
    };
  }
  const r = await runCommand({ cmd: cmd.cmd, args: cmd.args, ctx });
  return {
    output: r,
    brief: `${label}: ${cmd.cmd} ${cmd.args.join(' ')} (exit=${r.exitCode})`,
  };
}

const installSkill: AnySkill = {
  name: 'build.run_install',
  description: 'Install project dependencies. Stack auto-detected from lockfile / manifest (Node / Python / Go / Java / PHP / Ruby / Rust / .NET).',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  sideEffectClass: 'write_workspace',
  capabilities: ['process.spawn', 'fs.write', 'net.outbound'],
  timeoutMs: 600_000,
  async execute(_input, ctx) {
    return runStackCommand(ctx, (c) => c.install, 'install');
  },
};

const typecheckSkill: AnySkill = {
  name: 'build.run_typecheck',
  description: 'Run the language-native typecheck (tsc, mypy, go build ./..., mvn compile, …).',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  sideEffectClass: 'read',
  capabilities: ['process.spawn', 'fs.read'],
  timeoutMs: 600_000,
  async execute(_input, ctx) {
    return runStackCommand(ctx, (c) => c.typecheck, 'typecheck');
  },
};

const lintSkill: AnySkill = {
  name: 'build.run_lint',
  description: 'Run the language-native lint (eslint, ruff, golangci-lint, spotless, …).',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  sideEffectClass: 'read',
  capabilities: ['process.spawn', 'fs.read'],
  timeoutMs: 600_000,
  async execute(_input, ctx) {
    return runStackCommand(ctx, (c) => c.lint, 'lint');
  },
};

const unitTestsSkill: AnySkill = {
  name: 'build.run_unit_tests',
  description: 'Run the language-native unit tests (jest/vitest, pytest, go test, mvn test, …).',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  sideEffectClass: 'read',
  capabilities: ['process.spawn', 'fs.read'],
  timeoutMs: 600_000,
  async execute(_input, ctx) {
    return runStackCommand(ctx, (c) => c.test, 'tests');
  },
};

const integrationSkill: AnySkill = {
  name: 'build.run_integration_tests',
  description: 'Run the language-native integration tests, if defined for the stack.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  sideEffectClass: 'read',
  capabilities: ['process.spawn', 'fs.read'],
  timeoutMs: 600_000,
  async execute(_input, ctx) {
    return runStackCommand(ctx, (c) => c.integration, 'integration');
  },
};

export const buildSkills: AnySkill[] = [
  installSkill,
  typecheckSkill,
  lintSkill,
  unitTestsSkill,
  integrationSkill,
];
