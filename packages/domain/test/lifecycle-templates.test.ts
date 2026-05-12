/**
 * Stock lifecycle templates (#392) are the one-click onboarding payload
 * served to operators creating a new project. If any template's YAML
 * stops parsing, or its parsed form drifts from its YAML, the picker
 * silently ships a broken lifecycle that crashes the orchestrator on
 * the first run. This test locks both in.
 */
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { MergecrewConfig } from '../src/lifecycle.js';
import {
  STOCK_LIFECYCLE_TEMPLATES,
  findStockLifecycleTemplate,
} from '../src/lifecycle-templates.js';

describe('stock lifecycle templates (#392)', () => {
  it('exposes at least one template', () => {
    expect(STOCK_LIFECYCLE_TEMPLATES.length).toBeGreaterThan(0);
  });

  it('uses unique ids', () => {
    const ids = STOCK_LIFECYCLE_TEMPLATES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('includes the generic-careful default', () => {
    expect(findStockLifecycleTemplate('generic-careful')).toBeDefined();
  });

  for (const tpl of STOCK_LIFECYCLE_TEMPLATES) {
    describe(tpl.id, () => {
      it('has non-empty display fields', () => {
        expect(tpl.name).not.toBe('');
        expect(tpl.description).not.toBe('');
        expect(tpl.stack.length).toBeGreaterThan(0);
      });

      it('parsed form validates against MergecrewConfig', () => {
        const result = MergecrewConfig.safeParse(tpl.parsed);
        if (!result.success) {
          throw new Error(
            `${tpl.id} parsed invalid: ${result.error.issues
              .map((i) => `${i.path.join('.')}: ${i.message}`)
              .join('; ')}`,
          );
        }
        expect(result.success).toBe(true);
      });

      it('sourceYaml parses and validates against MergecrewConfig', () => {
        const fromYaml = parseYaml(tpl.sourceYaml);
        const result = MergecrewConfig.safeParse(fromYaml);
        if (!result.success) {
          throw new Error(
            `${tpl.id} YAML invalid: ${result.error.issues
              .map((i) => `${i.path.join('.')}: ${i.message}`)
              .join('; ')}`,
          );
        }
        expect(result.success).toBe(true);
      });

      it('sourceYaml and parsed agree once both run through MergecrewConfig', () => {
        // Both inputs are normalized by the same schema so defaults are
        // filled identically — any drift between the YAML body and the
        // parsed literal surfaces here.
        const fromYaml = MergecrewConfig.parse(parseYaml(tpl.sourceYaml));
        const fromParsed = MergecrewConfig.parse(tpl.parsed);
        expect(fromYaml).toEqual(fromParsed);
      });

      it('defines the careful-graph trio with canonical kinds', () => {
        // Every stock template uses Planner / Coder / Reviewer so the
        // orchestrator's careful profile (#336) can dispatch without
        // template-specific code paths.
        const agentKeys = Object.keys(tpl.parsed.agents ?? {}).sort();
        expect(agentKeys).toEqual(['coder', 'planner', 'reviewer']);
        const agents = tpl.parsed.agents as Record<string, { kind: string }>;
        expect(agents.planner.kind).toBe('Planner');
        expect(agents.coder.kind).toBe('Coder');
        expect(agents.reviewer.kind).toBe('Reviewer');
      });
    });
  }
});
