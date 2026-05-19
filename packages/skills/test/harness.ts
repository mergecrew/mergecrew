import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ProcessDriver } from '@mergecrew/sandbox-driver';
import type { SkillExecutionContext } from '../src/types.js';

/**
 * Build a temporary workspace directory and a SkillExecutionContext that
 * targets it. Designed for one-shot use in a single test — call cleanup()
 * (or wrap in afterEach) when you're done.
 *
 * Defaults to a ProcessDriver-backed sandbox so build / repo.git.*
 * skills (which call `ctx.driver.exec()` after #560) work without
 * additional plumbing. Override `driver` / `sandbox` to inject mocks.
 */
export async function makeSandbox(over: Partial<SkillExecutionContext> = {}): Promise<{
  ctx: SkillExecutionContext;
  workspacePath: string;
  cleanup: () => Promise<void>;
}> {
  const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), 'mc-skill-test-'));
  const driver = over.driver ?? new ProcessDriver();
  const sandbox =
    over.sandbox ??
    (await driver.start({
      runId: over.runId ?? 'run-test',
      projectId: over.projectId ?? 'project-test',
      organizationId: over.organizationId ?? 'org-test',
      workspacePath: over.workspacePath ?? workspacePath,
    }));
  const ctx: SkillExecutionContext = {
    organizationId: over.organizationId ?? 'org-test',
    projectId: over.projectId ?? 'project-test',
    runId: over.runId ?? 'run-test',
    workspacePath: over.workspacePath ?? workspacePath,
    abortSignal: over.abortSignal ?? new AbortController().signal,
    logger: over.logger ?? {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    },
    adapters: over.adapters ?? {},
    config: over.config,
    driver,
    sandbox,
  };
  return {
    ctx,
    workspacePath,
    cleanup: async () => {
      await driver.stop(sandbox).catch(() => {});
      await fs.rm(workspacePath, { recursive: true, force: true });
    },
  };
}
