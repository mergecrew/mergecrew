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

  it('includes the roster template and lists it first (default-applied #515)', () => {
    expect(findStockLifecycleTemplate('roster')).toBeDefined();
    expect(STOCK_LIFECYCLE_TEMPLATES[0]?.id).toBe('roster');
  });

  // Per-template agent-kind expectations. The careful-flow templates
  // all ship the Planner/Coder/Reviewer trio; the roster ships the full
  // 10-agent specialized set (#514).
  const CAREFUL_TRIO = ['coder', 'planner', 'reviewer'];
  const ROSTER_AGENTS = [
    'backend_engineer',
    'bug_triage',
    'design_reviewer',
    'discovery',
    'doc_writer',
    'frontend_engineer',
    'observation',
    'pm',
    'qa',
    'sre',
  ];

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

      it('declares the expected agent kinds for its profile', () => {
        const agentKeys = Object.keys(tpl.parsed.agents ?? {}).sort();
        const agents = tpl.parsed.agents as Record<string, { kind: string }>;
        if (tpl.id === 'roster') {
          expect(agentKeys).toEqual(ROSTER_AGENTS);
          expect(agents.discovery!.kind).toBe('Discovery');
          expect(agents.pm!.kind).toBe('PM');
          expect(agents.backend_engineer!.kind).toBe('BackendEngineer');
          expect(agents.frontend_engineer!.kind).toBe('FrontendEngineer');
          expect(agents.qa!.kind).toBe('QA');
          expect(agents.sre!.kind).toBe('SRE');
          expect(agents.observation!.kind).toBe('Observation');
          expect(agents.design_reviewer!.kind).toBe('DesignReviewer');
          expect(agents.bug_triage!.kind).toBe('BugTriage');
          expect(agents.doc_writer!.kind).toBe('DocWriter');
        } else {
          // Every other template is a careful-flow variant with the
          // Planner / Coder / Reviewer trio (#336).
          expect(agentKeys).toEqual(CAREFUL_TRIO);
          expect(agents.planner!.kind).toBe('Planner');
          expect(agents.coder!.kind).toBe('Coder');
          expect(agents.reviewer!.kind).toBe('Reviewer');
        }
      });
    });
  }
});
