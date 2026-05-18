/**
 * Discovery-mode planner output parser (#492). The runner persists
 * `output.directions` from this parser and emits
 * PLANNER_DIRECTIONS_PROPOSED; the orchestrator routes on
 * `output.mode === 'discovery'` to terminate the chain before the coder.
 */
import { describe, expect, it } from 'vitest';
import { parsePlannerDirections, PLANNER_DISCOVERY_SYSTEM_PROMPT } from '../src/loop.js';

describe('parsePlannerDirections', () => {
  it('extracts three directions from the canonical shape', () => {
    const md = [
      '# Discovery directions',
      '',
      '## 1. Add a /healthz endpoint',
      '**Rationale**: The compose stack already greps it from quickstart-smoke.sh; the route is missing.',
      '**Files expected**: apps/api/src/routes/healthz.ts, apps/api/test/healthz.test.ts',
      '**Effort**: small',
      '',
      '## 2. Wire prettier into CI',
      '**Rationale**: package.json has prettier; no CI step runs it.',
      '**Files expected**: .github/workflows/ci.yml, package.json',
      '**Effort**: small',
      '',
      '## 3. Type the public API surface',
      '**Rationale**: src/api uses `any` on request bodies — easy first pass.',
      '**Files expected**: apps/api/src/routes/*.ts',
      '**Effort**: medium',
    ].join('\n');

    const directions = parsePlannerDirections(md);
    expect(directions).toHaveLength(3);
    expect(directions[0]).toEqual({
      title: 'Add a /healthz endpoint',
      rationale: 'The compose stack already greps it from quickstart-smoke.sh; the route is missing.',
      filesExpected: ['apps/api/src/routes/healthz.ts', 'apps/api/test/healthz.test.ts'],
      effort: 'small',
    });
    expect(directions[1]!.title).toBe('Wire prettier into CI');
    expect(directions[2]!.effort).toBe('medium');
  });

  it('survives a partial / lossy output — missing fields land as empty strings', () => {
    const md = [
      '# Discovery directions',
      '',
      '## 1. Do the thing',
      '**Rationale**: because',
      '',
      '## 2. Another thing',
    ].join('\n');
    const directions = parsePlannerDirections(md);
    expect(directions).toHaveLength(2);
    expect(directions[0]).toEqual({
      title: 'Do the thing',
      rationale: 'because',
      filesExpected: [],
      effort: '',
    });
    expect(directions[1]).toEqual({
      title: 'Another thing',
      rationale: '',
      filesExpected: [],
      effort: '',
    });
  });

  it('returns an empty array on completely free-form output (orchestrator still terminates via output.mode)', () => {
    expect(parsePlannerDirections("I don't have enough context to propose anything.")).toEqual([]);
  });
});

describe('PLANNER_DISCOVERY_SYSTEM_PROMPT', () => {
  it('exists and asks for exactly three directions', () => {
    expect(PLANNER_DISCOVERY_SYSTEM_PROMPT).toMatch(/discovery mode/i);
    expect(PLANNER_DISCOVERY_SYSTEM_PROMPT).toMatch(/three|3/i);
    // The format block the parser depends on must be in the prompt.
    expect(PLANNER_DISCOVERY_SYSTEM_PROMPT).toContain('## 1.');
    expect(PLANNER_DISCOVERY_SYSTEM_PROMPT).toContain('**Rationale**');
    expect(PLANNER_DISCOVERY_SYSTEM_PROMPT).toContain('**Files expected**');
    expect(PLANNER_DISCOVERY_SYSTEM_PROMPT).toContain('**Effort**');
  });
});
