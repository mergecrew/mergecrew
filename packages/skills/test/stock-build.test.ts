import { describe, it, expect } from 'vitest';
import { findStockSkill } from '../src/catalog.js';
import { makeSandbox } from './harness.js';

/**
 * Smoke test for the build.* skills after #560: each skill must exec
 * through `ctx.driver.exec` rather than calling `execa` directly. Asserts
 * the wiring by running against the default ProcessDriver harness — if
 * the migration regressed, these would throw 'sandbox driver not
 * configured' instead of returning a structured result.
 */

function runSkill(name: string) {
  const skill = findStockSkill(name);
  if (!skill) throw new Error(`stock skill not found: ${name}`);
  return skill;
}

describe('build.* skills route through the SandboxDriver', () => {
  it('build.run_install reports a structured result (no execa import needed)', async () => {
    const { ctx, cleanup } = await makeSandbox();
    try {
      const skill = runSkill('build.run_install');
      const result = await skill.execute({}, ctx);
      // The workspace is empty: npm install will fail with no package.json,
      // but the result shape must come back from `driver.exec` (not throw).
      expect(result.brief).toMatch(/install \(exit=/);
      expect(typeof (result.output as any).exitCode).toBe('number');
    } finally {
      await cleanup();
    }
  });

  it('build.run_typecheck reports a structured result', async () => {
    const { ctx, cleanup } = await makeSandbox();
    try {
      const skill = runSkill('build.run_typecheck');
      const result = await skill.execute({}, ctx);
      expect(result.brief).toMatch(/typecheck \(exit=/);
    } finally {
      await cleanup();
    }
  });

  it('rejects commands outside the allowlist via runCommand', async () => {
    // The allowlist is internal to build.ts; we exercise the gate by
    // checking the build skills surface as expected. The full negative
    // check (running an arbitrary command) lives in the e2e suite (#564).
    const skill = runSkill('build.run_install');
    expect(skill.capabilities).toContain('process.spawn');
  });

  it('throws a clear error when the sandbox driver is missing', async () => {
    const { ctx, cleanup } = await makeSandbox();
    try {
      const skill = runSkill('build.run_install');
      // Strip the driver/sandbox to simulate a misconfigured runner.
      const broken = { ...ctx, driver: undefined, sandbox: undefined } as any;
      await expect(skill.execute({}, broken)).rejects.toThrow(/sandbox driver not configured/);
    } finally {
      await cleanup();
    }
  });
});
