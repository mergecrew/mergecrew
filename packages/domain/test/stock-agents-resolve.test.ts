/**
 * `resolveAgentByRef` is the bridge between the careful-profile graph
 * (which names nodes `planner` / `coder` / `reviewer`) and whatever
 * the operator wrote in `mergecrew.yaml`. The orchestrator + runner
 * both call this so the lifecycle-first, stock-fallback rule stays
 * single-sourced.
 */
import { describe, expect, it } from 'vitest';
import { resolveAgentByRef, STOCK_CODER_AGENT, STOCK_PLANNER_AGENT } from '../src/stock-agents.js';
import type { AgentDefinition } from '../src/lifecycle.js';

const userPlanner: AgentDefinition = {
  kind: 'Planner',
  description: 'user-defined',
  fallback: [],
  skills: ['repo.read_file'],
  do_not_touch: [],
  maxStepsPerRun: 5,
  maxToolCallsPerStep: 5,
};

describe('resolveAgentByRef (#348)', () => {
  it('returns the lifecycle agent when the operator defined one', () => {
    const resolved = resolveAgentByRef({ planner: userPlanner }, 'planner');
    expect(resolved).toBe(userPlanner);
    expect(resolved!.description).toBe('user-defined');
  });

  it('falls back to the stock planner when the operator did not define one', () => {
    expect(resolveAgentByRef({}, 'planner')).toBe(STOCK_PLANNER_AGENT);
    expect(resolveAgentByRef(undefined, 'planner')).toBe(STOCK_PLANNER_AGENT);
  });

  it('falls back to the stock coder by lowercase canonical ref', () => {
    expect(resolveAgentByRef({}, 'coder')).toBe(STOCK_CODER_AGENT);
  });

  it('returns undefined for an unknown agentRef with no stock match', () => {
    expect(resolveAgentByRef({}, 'mystery')).toBeUndefined();
  });

  it('lifecycle entry wins over stock even when the canonical agentRef matches', () => {
    const customCoder: AgentDefinition = { ...userPlanner, kind: 'Coder' };
    const resolved = resolveAgentByRef({ coder: customCoder }, 'coder');
    expect(resolved).toBe(customCoder);
    expect(resolved).not.toBe(STOCK_CODER_AGENT);
  });
});
