import { describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { findStockSkill } from '../src/catalog.js';
import { makeSandbox } from './harness.js';

/**
 * Smoke tests for the build.* skills after #560 (driver routing) +
 * #566 (stack detection / not_configured signal). Wraps the harness's
 * default ProcessDriver — under DockerDriver the same skill code path
 * runs unchanged.
 */

function runSkill(name: string) {
  const skill = findStockSkill(name);
  if (!skill) throw new Error(`stock skill not found: ${name}`);
  return skill;
}

describe('build.* skills with stack detection', () => {
  it('empty workspace → notConfigured (not tests_fail)', async () => {
    const { ctx, cleanup } = await makeSandbox();
    try {
      const r = await runSkill('build.run_install').execute({}, ctx);
      expect((r.output as any).notConfigured).toBe(true);
      expect(r.brief).toMatch(/install: not configured/);
    } finally {
      await cleanup();
    }
  });

  it('typecheck on empty workspace surfaces notConfigured', async () => {
    const { ctx, cleanup } = await makeSandbox();
    try {
      const r = await runSkill('build.run_typecheck').execute({}, ctx);
      expect((r.output as any).notConfigured).toBe(true);
    } finally {
      await cleanup();
    }
  });

  it('Node project (package.json + pnpm lock) → real exec, not notConfigured', async () => {
    const { ctx, workspacePath, cleanup } = await makeSandbox();
    try {
      // Create the minimal Node project shape so detectStack picks pnpm.
      await fs.writeFile(path.join(workspacePath, 'package.json'), '{}');
      await fs.writeFile(path.join(workspacePath, 'pnpm-lock.yaml'), '');
      const r = await runSkill('build.run_typecheck').execute({}, ctx);
      // pnpm isn't installed in CI's bare env, so we expect a real
      // exec with a non-zero exit — what matters is the result shape:
      // exitCode is present, notConfigured is not.
      expect((r.output as any).notConfigured).toBeUndefined();
      expect(typeof (r.output as any).exitCode).toBe('number');
      expect(r.brief).toMatch(/typecheck: pnpm run typecheck \(exit=/);
    } finally {
      await cleanup();
    }
  });

  it('throws clearly when sandbox driver is missing AND a command is configured', async () => {
    const { ctx, workspacePath, cleanup } = await makeSandbox();
    try {
      // Make detectStack pick a real stack (so a runCommand is attempted).
      await fs.writeFile(path.join(workspacePath, 'package.json'), '{}');
      const broken = { ...ctx, driver: undefined, sandbox: undefined } as any;
      await expect(
        runSkill('build.run_install').execute({}, broken),
      ).rejects.toThrow(/sandbox driver not configured/);
    } finally {
      await cleanup();
    }
  });

  it('mergecrew.yaml build.commands override fully replaces a detected command', async () => {
    const { ctx, workspacePath, cleanup } = await makeSandbox({
      config: { build: { commands: { test: { cmd: 'sh', args: ['-c', 'echo overridden'] } } } },
    });
    try {
      await fs.writeFile(path.join(workspacePath, 'package.json'), '{}');
      const r = await runSkill('build.run_unit_tests').execute({}, ctx);
      expect((r.output as any).exitCode).toBe(0);
      expect((r.output as any).stdout).toMatch(/overridden/);
      expect(r.brief).toMatch(/tests: sh -c echo overridden/);
    } finally {
      await cleanup();
    }
  });
});
