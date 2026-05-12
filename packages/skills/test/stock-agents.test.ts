/**
 * Cross-check the V2.ae stock agent definitions (#347) against the
 * live skills catalog. The stock agents live in `@mergecrew/domain`
 * (no skills dep) so this test lives here, where the catalog is
 * already imported.
 *
 * The point is to catch the case where a skill gets renamed or
 * deleted but a stock agent's skills list isn't updated — that would
 * boot a careful-profile run with a tool name the runtime can't
 * resolve, and the failure mode would be silent (filtered out by
 * bindTools without a clear message).
 */
import { describe, it, expect } from 'vitest';
import {
  STOCK_AGENTS,
  STOCK_PLANNER_AGENT,
  STOCK_CODER_AGENT,
  STOCK_REVIEWER_AGENT,
  type AgentDefinition,
} from '@mergecrew/domain';
import { findStockSkill } from '../src/catalog.js';

// AgentDefinition.skills entries are `string | { name, config }`.
function skillName(entry: AgentDefinition['skills'][number]): string {
  return typeof entry === 'string' ? entry : entry.name;
}

describe('stock agents — skill catalog cross-check (#347)', () => {
  it.each(Object.entries(STOCK_AGENTS))(
    'every skill referenced by the %s stock agent exists in the catalog',
    (_kind, agent) => {
      const missing = agent.skills.map(skillName).filter((name) => !findStockSkill(name));
      expect(missing, `unknown skills on ${agent.kind}: ${missing.join(', ')}`).toEqual([]);
    },
  );

  it('planner only references read-side skills (the runtime filters writes anyway, but lint the request)', () => {
    for (const entry of STOCK_PLANNER_AGENT.skills) {
      const name = skillName(entry);
      const skill = findStockSkill(name);
      expect(skill, `planner skill ${name} resolves`).toBeDefined();
      expect(skill!.sideEffectClass, `planner skill ${name} is read-only`).toBe('read');
    }
  });

  it('reviewer only references read-side skills', () => {
    for (const entry of STOCK_REVIEWER_AGENT.skills) {
      const name = skillName(entry);
      const skill = findStockSkill(name);
      expect(skill, `reviewer skill ${name} resolves`).toBeDefined();
      expect(skill!.sideEffectClass, `reviewer skill ${name} is read-only`).toBe('read');
    }
  });

  it('coder has at least one write-side skill (otherwise the careful flow can never produce a diff)', () => {
    const writeSkills = STOCK_CODER_AGENT.skills
      .map(skillName)
      .map((n) => findStockSkill(n))
      .filter((s): s is NonNullable<typeof s> => Boolean(s))
      .filter((s) => s.sideEffectClass !== 'read');
    expect(writeSkills.length, 'coder needs at least one non-read skill').toBeGreaterThan(0);
  });

  it('STOCK_AGENTS map keys match each agent.kind', () => {
    for (const [key, agent] of Object.entries(STOCK_AGENTS)) {
      expect(agent.kind, `STOCK_AGENTS.${key}.kind`).toBe(key);
    }
  });
});
