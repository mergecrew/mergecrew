import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { SkillExecutionContext } from '../src/types.js';

/**
 * Build a temporary workspace directory and a SkillExecutionContext that
 * targets it. Designed for one-shot use in a single test — call cleanup()
 * (or wrap in afterEach) when you're done.
 *
 * Default ctx values are minimal but valid: empty adapters, no logger
 * spam, a fresh AbortController. Override anything you need via `over`.
 */
export async function makeSandbox(over: Partial<SkillExecutionContext> = {}): Promise<{
  ctx: SkillExecutionContext;
  workspacePath: string;
  cleanup: () => Promise<void>;
}> {
  const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), 'mc-skill-test-'));
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
  };
  return {
    ctx,
    workspacePath,
    cleanup: () => fs.rm(workspacePath, { recursive: true, force: true }),
  };
}
