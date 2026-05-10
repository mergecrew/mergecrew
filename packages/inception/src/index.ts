export * from './types.js';
export { detectStack } from './detect.js';
export { buildDraftYaml } from './draft-yaml.js';

import { detectStack } from './detect.js';
import { buildDraftYaml } from './draft-yaml.js';
import type { InceptionResult } from './types.js';

/**
 * One-shot helper: run the detector and emit the draft yaml in one call.
 * Most callers want this; the lower-level `detectStack` + `buildDraftYaml`
 * pair is exposed for tests and tooling that wants to inspect the summary.
 */
export async function runInception(workspacePath: string): Promise<InceptionResult> {
  const summary = await detectStack(workspacePath);
  const draftYaml = buildDraftYaml(summary);
  return { summary, draftYaml };
}
