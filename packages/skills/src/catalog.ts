import { repoSkills } from './stock/repo.js';
import { buildSkills } from './stock/build.js';
import { deploySkills } from './stock/deploy.js';
import { webSkills } from './stock/web.js';
import { errorsSkills } from './stock/errors.js';
import { trackerSkills } from './stock/tracker.js';
import { commsSkills } from './stock/comms.js';
import { memorySkills } from './stock/memory.js';
import { llmSkills } from './stock/llm.js';
import type { AnySkill } from './types.js';

export const stockSkills: AnySkill[] = [
  ...repoSkills,
  ...buildSkills,
  ...deploySkills,
  ...webSkills,
  ...errorsSkills,
  ...trackerSkills,
  ...commsSkills,
  ...memorySkills,
  ...llmSkills,
];

export function findStockSkill(name: string): AnySkill | undefined {
  return stockSkills.find((s) => s.name === name);
}
