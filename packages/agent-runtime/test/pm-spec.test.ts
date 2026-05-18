/**
 * parsePmSpec covers the PM agent output contract (#517). The engineer
 * agents downstream depend on the structured shape; a parser regression
 * silently breaks the roster chain after PM completes.
 */
import { describe, expect, it } from 'vitest';
import { parsePmSpec, STUB_PM_SPEC } from '../src/loop.js';

describe('parsePmSpec — canonical shape (matches PM_SYSTEM_PROMPT)', () => {
  it('parses title / target / motivation / scope / acceptance criteria', () => {
    const md = [
      '# Add a /healthz endpoint',
      '',
      '## Target',
      'backend',
      '',
      '## Motivation',
      'The container probe in docker-compose.prod.yml expects /healthz but the api currently 404s.',
      '',
      '## Scope',
      'Backend only. Add the route handler in apps/api; no frontend work needed.',
      '',
      '## Acceptance criteria',
      '- GET /healthz returns 200',
      '- The response body is `{"ok": true}`',
      '- An integration test covers the endpoint',
    ].join('\n');
    const result = parsePmSpec(md);
    expect(result).toEqual({
      title: 'Add a /healthz endpoint',
      target: 'backend',
      motivation:
        'The container probe in docker-compose.prod.yml expects /healthz but the api currently 404s.',
      scope: 'Backend only. Add the route handler in apps/api; no frontend work needed.',
      acceptanceCriteria: [
        'GET /healthz returns 200',
        'The response body is `{"ok": true}`',
        'An integration test covers the endpoint',
      ],
    });
  });

  it('parses the canonical STUB_PM_SPEC fixture', () => {
    const result = parsePmSpec(STUB_PM_SPEC);
    expect(result).not.toBeNull();
    expect(result!.title).toContain('Stub spec');
    expect(result!.target).toBe('both');
    expect(result!.motivation.length).toBeGreaterThan(0);
    expect(result!.scope.length).toBeGreaterThan(0);
    expect(result!.acceptanceCriteria.length).toBeGreaterThanOrEqual(3);
  });
});

describe('parsePmSpec — Target tag drives engineer dispatch (#518 D3)', () => {
  const baseSections = [
    '## Motivation',
    'm',
    '',
    '## Scope',
    's',
    '',
    '## Acceptance criteria',
    '- one',
  ];

  it('parses `backend` target', () => {
    const md = ['# t', '', '## Target', 'backend', '', ...baseSections].join('\n');
    expect(parsePmSpec(md)?.target).toBe('backend');
  });

  it('parses `frontend` target', () => {
    const md = ['# t', '', '## Target', 'frontend', '', ...baseSections].join('\n');
    expect(parsePmSpec(md)?.target).toBe('frontend');
  });

  it('parses `both` target', () => {
    const md = ['# t', '', '## Target', 'both', '', ...baseSections].join('\n');
    expect(parsePmSpec(md)?.target).toBe('both');
  });

  it('defaults to `both` when the Target section is missing', () => {
    // Failure mode is "ran an unnecessary engineer," not "skipped a needed one".
    const md = ['# t', '', ...baseSections].join('\n');
    expect(parsePmSpec(md)?.target).toBe('both');
  });

  it('tolerates surrounding markdown decoration on the target value', () => {
    const md = ['# t', '', '## Target', '**backend**', '', ...baseSections].join('\n');
    expect(parsePmSpec(md)?.target).toBe('backend');
  });

  it('falls back to `both` when the target value is unrecognized', () => {
    const md = ['# t', '', '## Target', 'mobile', '', ...baseSections].join('\n');
    expect(parsePmSpec(md)?.target).toBe('both');
  });
});

describe('parsePmSpec — tolerant of common LLM drift', () => {
  it('accepts an H2 title when the model drops the H1 level', () => {
    const md = [
      '## Add a /healthz endpoint',
      '',
      '## Motivation',
      'The probe needs it.',
      '',
      '## Scope',
      'Backend.',
      '',
      '## Acceptance criteria',
      '- Returns 200',
    ].join('\n');
    const result = parsePmSpec(md);
    expect(result?.title).toBe('Add a /healthz endpoint');
  });

  it('does not pick a section header as the title fallback', () => {
    // An H2 that matches a known section name must not be treated as the title.
    const md = [
      '## Motivation',
      'Something',
      '## Scope',
      'Something else',
      '## Acceptance criteria',
      '- x',
    ].join('\n');
    expect(parsePmSpec(md)).toBeNull();
  });

  it('accepts numbered-list acceptance bullets', () => {
    const md = [
      '# t',
      '## Motivation',
      'm',
      '## Scope',
      's',
      '## Acceptance criteria',
      '1. first',
      '2) second',
      '3) third',
    ].join('\n');
    expect(parsePmSpec(md)?.acceptanceCriteria).toEqual(['first', 'second', 'third']);
  });

  it('accepts bold-wrapped section headers', () => {
    const md = [
      '# t',
      '',
      '**Motivation**',
      'm',
      '',
      '**Scope**',
      's',
      '',
      '**Acceptance criteria**',
      '- one',
      '- two',
    ].join('\n');
    const result = parsePmSpec(md);
    expect(result?.motivation).toBe('m');
    expect(result?.scope).toBe('s');
    expect(result?.acceptanceCriteria).toEqual(['one', 'two']);
  });

  it('handles inline prose before the spec block', () => {
    const md = [
      'Here is my scoped spec.',
      '',
      '# Add /healthz',
      '## Motivation',
      'probe',
      '## Scope',
      'backend',
      '## Acceptance criteria',
      '- 200',
    ].join('\n');
    expect(parsePmSpec(md)?.title).toBe('Add /healthz');
  });
});

describe('parsePmSpec — returns null on truly unparseable output', () => {
  it('returns null for empty input', () => {
    expect(parsePmSpec('')).toBeNull();
    expect(parsePmSpec('   \n\n')).toBeNull();
  });

  it('returns null on an explicit SPEC_GAP response', () => {
    // The prompt instructs PM to lead with `SPEC_GAP:` when it can't
    // scope. The parser refuses these so the runner emits a step
    // failure instead of dispatching engineers against nothing.
    const md = 'SPEC_GAP: The intent is too vague — please add an acceptance criterion.';
    expect(parsePmSpec(md)).toBeNull();
  });

  it('returns null when no title is present (just prose)', () => {
    expect(parsePmSpec('I think we should add a healthz endpoint, returning 200.')).toBeNull();
  });
});
