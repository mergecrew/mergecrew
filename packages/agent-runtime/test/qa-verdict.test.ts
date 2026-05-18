/**
 * parseQaVerdict covers the QA agent output contract (#520). The
 * orchestrator routes on `output.verdict` (tests_pass → deploy_dev,
 * tests_fail → pm), so a parser regression silently advances broken
 * changesets — or, in the other direction, dead-ends working ones.
 */
import { describe, expect, it } from 'vitest';
import { parseQaVerdict } from '../src/loop.js';

describe('parseQaVerdict — canonical shape (matches QA_SYSTEM_PROMPT)', () => {
  it('parses the prompt-prescribed tests_pass shape', () => {
    const text = [
      'VERDICT: tests_pass',
      'SUMMARY: 142 passed, 0 failed across 18 suites.',
    ].join('\n');
    expect(parseQaVerdict(text)).toEqual({
      verdict: 'tests_pass',
      summary: '142 passed, 0 failed across 18 suites.',
      failureExcerpts: [],
    });
  });

  it('parses the prompt-prescribed tests_fail shape with FAILURES bullets', () => {
    const text = [
      'VERDICT: tests_fail',
      'SUMMARY: 2 failed, 140 passed.',
      'FAILURES:',
      '- unit tests: AssertionError at packages/billing/test/quote.test.ts:42',
      '- integration tests: timeout after 30s in webhook flow',
    ].join('\n');
    expect(parseQaVerdict(text)).toEqual({
      verdict: 'tests_fail',
      summary: '2 failed, 140 passed.',
      failureExcerpts: [
        'unit tests: AssertionError at packages/billing/test/quote.test.ts:42',
        'integration tests: timeout after 30s in webhook flow',
      ],
    });
  });
});

describe('parseQaVerdict — tolerant of common LLM drift', () => {
  it('accepts a JSON object envelope', () => {
    const text = `\`\`\`json
{ "verdict": "tests_fail", "summary": "1 failed", "failureExcerpts": ["typecheck: TS2322"] }
\`\`\``;
    expect(parseQaVerdict(text)).toEqual({
      verdict: 'tests_fail',
      summary: '1 failed',
      failureExcerpts: ['typecheck: TS2322'],
    });
  });

  it('accepts the `failures` alias on the JSON envelope', () => {
    const text = '{"verdict":"tests_fail","summary":"oops","failures":["a","b"]}';
    expect(parseQaVerdict(text)?.failureExcerpts).toEqual(['a', 'b']);
  });

  it('accepts markdown-decorated VERDICT line', () => {
    const text = [
      '**VERDICT:** tests_pass',
      '**SUMMARY:** green across the board',
    ].join('\n');
    expect(parseQaVerdict(text)).toEqual({
      verdict: 'tests_pass',
      summary: 'green across the board',
      failureExcerpts: [],
    });
  });

  it('accepts numbered FAILURES bullets', () => {
    const text = [
      'VERDICT: tests_fail',
      'SUMMARY: red',
      'FAILURES:',
      '1. step a: detail',
      '2) step b: detail',
    ].join('\n');
    expect(parseQaVerdict(text)?.failureExcerpts).toEqual([
      'step a: detail',
      'step b: detail',
    ]);
  });

  it('accepts leading prose before the verdict block', () => {
    const text = [
      'Here is the QA report for the changeset.',
      '',
      'VERDICT: tests_pass',
      'SUMMARY: all green',
    ].join('\n');
    expect(parseQaVerdict(text)?.verdict).toBe('tests_pass');
  });
});

describe('parseQaVerdict — returns null on truly unparseable output', () => {
  it('returns null for empty input', () => {
    expect(parseQaVerdict('')).toBeNull();
    expect(parseQaVerdict('   \n\n')).toBeNull();
  });

  it('returns null when the verdict value is not one of the two allowed', () => {
    expect(parseQaVerdict('VERDICT: maybe\nSUMMARY: shrug')).toBeNull();
  });

  it('returns null when there is no VERDICT line at all', () => {
    expect(parseQaVerdict('Tests passed, I think.')).toBeNull();
  });

  it('does not match `tests_pass` mentioned in prose without the VERDICT keyword', () => {
    expect(parseQaVerdict('I would say tests_pass but maybe not.')).toBeNull();
  });
});
