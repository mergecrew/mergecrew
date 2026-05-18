/**
 * Catalog smoke tests for the V2.af roster restoration (#514).
 *
 * Two properties matter here:
 *   1. Every new agent kind has a non-empty system prompt resolvable
 *      via `defaultSystemPrompt(kind)`. If we ever drop a prompt by
 *      mistake the runtime falls back to a generic "you are a ${kind}"
 *      template — usable but bad — so the test pins the wiring.
 *   2. The read-only set covers exactly the kinds whose system prompts
 *      describe a no-write role. Off-by-one here means a misconfigured
 *      lifecycle could expose `repo.write_file` to the PM agent.
 */
import { describe, expect, it } from 'vitest';
import {
  PLANNER_AGENT_KIND,
  CODER_AGENT_KIND,
  REVIEWER_AGENT_KIND,
  DISCOVERY_AGENT_KIND,
  PM_AGENT_KIND,
  BACKEND_ENGINEER_AGENT_KIND,
  FRONTEND_ENGINEER_AGENT_KIND,
  QA_AGENT_KIND,
  SRE_AGENT_KIND,
  DESIGN_REVIEWER_AGENT_KIND,
  OBSERVATION_AGENT_KIND,
  BUG_TRIAGE_AGENT_KIND,
  DOC_WRITER_AGENT_KIND,
  READ_ONLY_AGENT_KINDS,
  DISCOVERY_SYSTEM_PROMPT,
  PM_SYSTEM_PROMPT,
  BACKEND_ENGINEER_SYSTEM_PROMPT,
  FRONTEND_ENGINEER_SYSTEM_PROMPT,
  QA_SYSTEM_PROMPT,
  SRE_SYSTEM_PROMPT,
  DESIGN_REVIEWER_SYSTEM_PROMPT,
  OBSERVATION_SYSTEM_PROMPT,
  BUG_TRIAGE_SYSTEM_PROMPT,
  DOC_WRITER_SYSTEM_PROMPT,
} from '../src/loop.js';

const ROSTER_KINDS = [
  DISCOVERY_AGENT_KIND,
  PM_AGENT_KIND,
  BACKEND_ENGINEER_AGENT_KIND,
  FRONTEND_ENGINEER_AGENT_KIND,
  QA_AGENT_KIND,
  SRE_AGENT_KIND,
  DESIGN_REVIEWER_AGENT_KIND,
  OBSERVATION_AGENT_KIND,
  BUG_TRIAGE_AGENT_KIND,
  DOC_WRITER_AGENT_KIND,
];

const ROSTER_PROMPTS: Record<string, string> = {
  [DISCOVERY_AGENT_KIND]: DISCOVERY_SYSTEM_PROMPT,
  [PM_AGENT_KIND]: PM_SYSTEM_PROMPT,
  [BACKEND_ENGINEER_AGENT_KIND]: BACKEND_ENGINEER_SYSTEM_PROMPT,
  [FRONTEND_ENGINEER_AGENT_KIND]: FRONTEND_ENGINEER_SYSTEM_PROMPT,
  [QA_AGENT_KIND]: QA_SYSTEM_PROMPT,
  [SRE_AGENT_KIND]: SRE_SYSTEM_PROMPT,
  [DESIGN_REVIEWER_AGENT_KIND]: DESIGN_REVIEWER_SYSTEM_PROMPT,
  [OBSERVATION_AGENT_KIND]: OBSERVATION_SYSTEM_PROMPT,
  [BUG_TRIAGE_AGENT_KIND]: BUG_TRIAGE_SYSTEM_PROMPT,
  [DOC_WRITER_AGENT_KIND]: DOC_WRITER_SYSTEM_PROMPT,
};

describe('roster agent-kind constants (#514)', () => {
  it('exposes each kind as its canonical PascalCase string', () => {
    expect(DISCOVERY_AGENT_KIND).toBe('Discovery');
    expect(PM_AGENT_KIND).toBe('PM');
    expect(BACKEND_ENGINEER_AGENT_KIND).toBe('BackendEngineer');
    expect(FRONTEND_ENGINEER_AGENT_KIND).toBe('FrontendEngineer');
    expect(QA_AGENT_KIND).toBe('QA');
    expect(SRE_AGENT_KIND).toBe('SRE');
    expect(DESIGN_REVIEWER_AGENT_KIND).toBe('DesignReviewer');
    expect(OBSERVATION_AGENT_KIND).toBe('Observation');
    expect(BUG_TRIAGE_AGENT_KIND).toBe('BugTriage');
    expect(DOC_WRITER_AGENT_KIND).toBe('DocWriter');
  });

  it('keeps the legacy Planner / Coder / Reviewer kinds unchanged for backward-compat', () => {
    expect(PLANNER_AGENT_KIND).toBe('Planner');
    expect(CODER_AGENT_KIND).toBe('Coder');
    expect(REVIEWER_AGENT_KIND).toBe('Reviewer');
  });
});

describe('roster system prompts (#514)', () => {
  it('every roster kind has a non-empty prompt with multi-line content', () => {
    for (const kind of ROSTER_KINDS) {
      const prompt = ROSTER_PROMPTS[kind];
      expect(prompt, `missing prompt for ${kind}`).toBeTruthy();
      expect(prompt!.length, `prompt for ${kind} suspiciously short`).toBeGreaterThan(100);
      expect(prompt!).toContain('\n');
    }
  });

  it('each prompt names the agent it is for', () => {
    // Loose check — the original `default.ts` prompts all start with
    // "You are the <name> agent". If we ever rewrite them and break
    // that pattern this test won't fail catastrophically, but it pins
    // the convention while it holds.
    const expectations: [string, RegExp][] = [
      [DISCOVERY_AGENT_KIND, /Discovery agent/i],
      [PM_AGENT_KIND, /PM agent/i],
      [BACKEND_ENGINEER_AGENT_KIND, /Backend Engineer/i],
      [FRONTEND_ENGINEER_AGENT_KIND, /Frontend Engineer/i],
      [QA_AGENT_KIND, /QA agent/i],
      [SRE_AGENT_KIND, /SRE agent/i],
      [DESIGN_REVIEWER_AGENT_KIND, /Design Reviewer/i],
      [OBSERVATION_AGENT_KIND, /Observation agent/i],
      [BUG_TRIAGE_AGENT_KIND, /Bug Triage/i],
      [DOC_WRITER_AGENT_KIND, /Doc Writer/i],
    ];
    for (const [kind, pattern] of expectations) {
      expect(ROSTER_PROMPTS[kind], `prompt for ${kind} doesn't self-identify`).toMatch(pattern);
    }
  });

  it('every prompt carries the prompt-injection-mitigation footer', () => {
    // Inputs from external content are untrusted — this is the
    // standard footer (`docs/02-architecture/11-security.md`). If a
    // future edit drops the footer accidentally we want to know.
    for (const kind of ROSTER_KINDS) {
      expect(
        ROSTER_PROMPTS[kind],
        `prompt for ${kind} missing the untrusted-input footer`,
      ).toMatch(/untrusted/i);
    }
  });

  it('QA prompt prescribes the tests_pass / tests_fail verdict shape', () => {
    // #520 (QA agent) and #516 (graph routing) both depend on this
    // pinned vocabulary — `tests_pass` and `tests_fail` are the signal
    // strings `dispatchGraphNext` will switch on.
    expect(QA_SYSTEM_PROMPT).toContain('VERDICT: tests_pass');
    expect(QA_SYSTEM_PROMPT).toContain('VERDICT: tests_fail');
  });

  it('PM prompt asks for title / target / motivation / scope / acceptance criteria', () => {
    // Pins the output shape #517 (PM agent) + #518 (target tag) will parse.
    expect(PM_SYSTEM_PROMPT).toMatch(/title/i);
    expect(PM_SYSTEM_PROMPT).toMatch(/## Target/);
    expect(PM_SYSTEM_PROMPT).toMatch(/motivation/i);
    expect(PM_SYSTEM_PROMPT).toMatch(/scope/i);
    expect(PM_SYSTEM_PROMPT).toMatch(/acceptance criteria/i);
  });

  it('BackendEngineer prompt describes the spec/skip input contract (#518 D3)', () => {
    // The runner short-circuits BE when PM tags a spec `target: frontend`
    // by setting `skip: true` on the input. The prompt must teach the
    // agent to emit `SKIPPED:` in that branch instead of running the
    // implementation workflow against a frontend-only spec.
    expect(BACKEND_ENGINEER_SYSTEM_PROMPT).toMatch(/skip/i);
    expect(BACKEND_ENGINEER_SYSTEM_PROMPT).toContain('SKIPPED:');
    expect(BACKEND_ENGINEER_SYSTEM_PROMPT).toMatch(/spec/i);
  });
});

describe('READ_ONLY_AGENT_KINDS coverage (#514)', () => {
  it('includes the read-only roster kinds (Discovery, PM, QA, DesignReviewer, Observation, BugTriage)', () => {
    expect(READ_ONLY_AGENT_KINDS.has(DISCOVERY_AGENT_KIND)).toBe(true);
    expect(READ_ONLY_AGENT_KINDS.has(PM_AGENT_KIND)).toBe(true);
    expect(READ_ONLY_AGENT_KINDS.has(QA_AGENT_KIND)).toBe(true);
    expect(READ_ONLY_AGENT_KINDS.has(DESIGN_REVIEWER_AGENT_KIND)).toBe(true);
    expect(READ_ONLY_AGENT_KINDS.has(OBSERVATION_AGENT_KIND)).toBe(true);
    expect(READ_ONLY_AGENT_KINDS.has(BUG_TRIAGE_AGENT_KIND)).toBe(true);
  });

  it('retains the legacy Planner + Reviewer kinds', () => {
    expect(READ_ONLY_AGENT_KINDS.has(PLANNER_AGENT_KIND)).toBe(true);
    expect(READ_ONLY_AGENT_KINDS.has(REVIEWER_AGENT_KIND)).toBe(true);
  });

  it('excludes the write-capable roster kinds (BackendEngineer, FrontendEngineer, SRE, DocWriter) and legacy Coder', () => {
    // Off-by-one in either direction is what this test exists for:
    // a write agent in this set would silently lose its write skills
    // at dispatch.
    expect(READ_ONLY_AGENT_KINDS.has(CODER_AGENT_KIND)).toBe(false);
    expect(READ_ONLY_AGENT_KINDS.has(BACKEND_ENGINEER_AGENT_KIND)).toBe(false);
    expect(READ_ONLY_AGENT_KINDS.has(FRONTEND_ENGINEER_AGENT_KIND)).toBe(false);
    expect(READ_ONLY_AGENT_KINDS.has(SRE_AGENT_KIND)).toBe(false);
    expect(READ_ONLY_AGENT_KINDS.has(DOC_WRITER_AGENT_KIND)).toBe(false);
  });
});
