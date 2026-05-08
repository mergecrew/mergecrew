import { execa } from 'execa';
import { ValidationError } from '@mergecrew/domain';
import type { AnySkill } from '../types.js';

const ALLOWLIST_CMDS = new Set([
  'npm', 'pnpm', 'yarn',
  'node', 'tsc', 'tsx',
  'eslint', 'prettier',
  'jest', 'vitest', 'playwright',
]);

interface RunOpts {
  cmd: string;
  args: string[];
  cwd: string;
  signal: AbortSignal;
  timeoutMs?: number;
}

async function runCommand(opts: RunOpts) {
  const cmd = opts.cmd;
  if (!ALLOWLIST_CMDS.has(cmd)) {
    throw new ValidationError(`command not allowed: ${cmd}`);
  }
  try {
    const r = await execa(cmd, opts.args, {
      cwd: opts.cwd,
      cancelSignal: opts.signal,
      timeout: opts.timeoutMs ?? 600_000,
      reject: false,
      env: {
        ...process.env,
        CI: 'true',
        FORCE_COLOR: '0',
      },
    });
    return {
      exitCode: r.exitCode ?? 0,
      stdout: tail(r.stdout ?? '', 8000),
      stderr: tail(r.stderr ?? '', 8000),
      timedOut: r.timedOut,
    };
  } catch (e: any) {
    return { exitCode: 1, stdout: '', stderr: String(e?.message ?? e), timedOut: false };
  }
}

function tail(s: string, max: number): string {
  return s.length <= max ? s : s.slice(s.length - max);
}

const installSkill: AnySkill = {
  name: 'build.run_install',
  description: 'Install dependencies. Detects pnpm/yarn/npm based on lockfile.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  sideEffectClass: 'write_workspace',
  capabilities: ['process.spawn', 'fs.write', 'net.outbound'],
  timeoutMs: 600_000,
  async execute(_input, ctx) {
    if (!ctx.workspacePath) throw new ValidationError('workspacePath required');
    const which = await detectPm(ctx.workspacePath);
    const args = which === 'pnpm' ? ['install', '--frozen-lockfile'] :
      which === 'yarn' ? ['install', '--frozen-lockfile'] :
      ['ci'];
    const r = await runCommand({ cmd: which, args, cwd: ctx.workspacePath, signal: ctx.abortSignal });
    return { output: r, brief: `${which} install (exit=${r.exitCode})` };
  },
};

const typecheckSkill: AnySkill = {
  name: 'build.run_typecheck',
  description: 'Run the project\'s typecheck script (e.g., npm run typecheck) or fall back to tsc --noEmit.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  sideEffectClass: 'read',
  capabilities: ['process.spawn', 'fs.read'],
  timeoutMs: 600_000,
  async execute(_input, ctx) {
    if (!ctx.workspacePath) throw new ValidationError('workspacePath required');
    const pm = await detectPm(ctx.workspacePath);
    const r = await runCommand({
      cmd: pm,
      args: ['run', 'typecheck'],
      cwd: ctx.workspacePath,
      signal: ctx.abortSignal,
    });
    return { output: r, brief: `typecheck (exit=${r.exitCode})` };
  },
};

const lintSkill: AnySkill = {
  name: 'build.run_lint',
  description: 'Run the project\'s lint script.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  sideEffectClass: 'read',
  capabilities: ['process.spawn', 'fs.read'],
  timeoutMs: 600_000,
  async execute(_input, ctx) {
    if (!ctx.workspacePath) throw new ValidationError('workspacePath required');
    const pm = await detectPm(ctx.workspacePath);
    const r = await runCommand({
      cmd: pm,
      args: ['run', 'lint'],
      cwd: ctx.workspacePath,
      signal: ctx.abortSignal,
    });
    return { output: r, brief: `lint (exit=${r.exitCode})` };
  },
};

const unitTestsSkill: AnySkill = {
  name: 'build.run_unit_tests',
  description: 'Run the project\'s unit tests.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  sideEffectClass: 'read',
  capabilities: ['process.spawn', 'fs.read'],
  timeoutMs: 600_000,
  async execute(_input, ctx) {
    if (!ctx.workspacePath) throw new ValidationError('workspacePath required');
    const pm = await detectPm(ctx.workspacePath);
    const r = await runCommand({
      cmd: pm,
      args: ['run', 'test'],
      cwd: ctx.workspacePath,
      signal: ctx.abortSignal,
    });
    return { output: r, brief: `tests (exit=${r.exitCode})` };
  },
};

const integrationSkill: AnySkill = {
  name: 'build.run_integration_tests',
  description: 'Run the project\'s integration tests.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  sideEffectClass: 'read',
  capabilities: ['process.spawn', 'fs.read'],
  timeoutMs: 600_000,
  async execute(_input, ctx) {
    if (!ctx.workspacePath) throw new ValidationError('workspacePath required');
    const pm = await detectPm(ctx.workspacePath);
    const r = await runCommand({
      cmd: pm,
      args: ['run', 'test:integration'],
      cwd: ctx.workspacePath,
      signal: ctx.abortSignal,
    });
    return { output: r, brief: `integration (exit=${r.exitCode})` };
  },
};

export const buildSkills: AnySkill[] = [
  installSkill,
  typecheckSkill,
  lintSkill,
  unitTestsSkill,
  integrationSkill,
];

async function detectPm(cwd: string): Promise<'pnpm' | 'yarn' | 'npm'> {
  const { promises: fs } = await import('node:fs');
  const path = (await import('node:path')).default;
  try {
    await fs.access(path.join(cwd, 'pnpm-lock.yaml'));
    return 'pnpm';
  } catch {}
  try {
    await fs.access(path.join(cwd, 'yarn.lock'));
    return 'yarn';
  } catch {}
  return 'npm';
}
