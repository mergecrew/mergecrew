/**
 * The demo lifecycle is what a first-time visitor sees as the
 * out-of-the-box multi-agent setup. If it doesn't parse against the
 * domain validator the orchestrator's `run.due` handler crashes on
 * the visitor's first manual trigger — visible failure, no fallback.
 * This test locks in that the seeded YAML + parsed JSON stay valid
 * even when the AgentDefinition schema evolves.
 */
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { MergecrewConfig } from '@mergecrew/domain';
import {
  DEMO_CAREFUL_LIFECYCLE_PARSED,
  DEMO_CAREFUL_LIFECYCLE_YAML,
} from '../src/demo-lifecycle.js';

describe('demo lifecycle (#361)', () => {
  it('parsed JSON validates against MergecrewConfig', () => {
    const result = MergecrewConfig.safeParse(DEMO_CAREFUL_LIFECYCLE_PARSED);
    if (!result.success) {
      throw new Error(`parsed JSON invalid: ${result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
    }
    expect(result.success).toBe(true);
  });

  it('YAML body parses to a shape that validates', () => {
    const fromYaml = parseYaml(DEMO_CAREFUL_LIFECYCLE_YAML);
    const result = MergecrewConfig.safeParse(fromYaml);
    if (!result.success) {
      throw new Error(`YAML invalid: ${result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
    }
    expect(result.success).toBe(true);
  });

  it('defines the three CAREFUL_GRAPH agents with canonical kinds', () => {
    expect(Object.keys(DEMO_CAREFUL_LIFECYCLE_PARSED.agents).sort()).toEqual([
      'coder',
      'planner',
      'reviewer',
    ]);
    expect(DEMO_CAREFUL_LIFECYCLE_PARSED.agents.planner.kind).toBe('Planner');
    expect(DEMO_CAREFUL_LIFECYCLE_PARSED.agents.coder.kind).toBe('Coder');
    expect(DEMO_CAREFUL_LIFECYCLE_PARSED.agents.reviewer.kind).toBe('Reviewer');
  });
});
