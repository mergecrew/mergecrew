import { describe, expect, it } from 'vitest';
import { parseReviewerVerdict } from '../src/loop.js';

describe('parseReviewerVerdict — canonical shape', () => {
  it('parses the prompt-prescribed approve shape', () => {
    const text = [
      'VERDICT: approve',
      'REASONING: Diff matches the plan, tests would pass.',
    ].join('\n');
    expect(parseReviewerVerdict(text)).toEqual({
      verdict: 'approve',
      reasoning: 'Diff matches the plan, tests would pass.',
      requestedChanges: [],
    });
  });

  it('parses the prompt-prescribed request_changes shape with bullets', () => {
    const text = [
      'VERDICT: request_changes',
      'REASONING: Missing error handling on the auth path.',
      'REQUESTED_CHANGES:',
      '- wrap parseJwt in a try/catch',
      '- emit a 401 on parse failure',
    ].join('\n');
    const result = parseReviewerVerdict(text);
    expect(result).toEqual({
      verdict: 'request_changes',
      reasoning: 'Missing error handling on the auth path.',
      requestedChanges: ['wrap parseJwt in a try/catch', 'emit a 401 on parse failure'],
    });
  });

  it('parses output wrapped in a code fence (as the prompt itself prescribes)', () => {
    const text = ['```', 'VERDICT: approve', 'REASONING: looks correct', '```'].join('\n');
    expect(parseReviewerVerdict(text)?.verdict).toBe('approve');
  });
});

describe('parseReviewerVerdict — JSON output', () => {
  it('accepts a clean JSON object with verdict + reasoning + requestedChanges', () => {
    const text = JSON.stringify({
      verdict: 'request_changes',
      reasoning: 'introduces a regression in the login flow',
      requestedChanges: ['revert the password hash change', 'add a regression test'],
    });
    expect(parseReviewerVerdict(text)).toEqual({
      verdict: 'request_changes',
      reasoning: 'introduces a regression in the login flow',
      requestedChanges: ['revert the password hash change', 'add a regression test'],
    });
  });

  it('accepts JSON inside a ```json code fence with prose around it', () => {
    const text = [
      'After reviewing the diff:',
      '',
      '```json',
      JSON.stringify({ verdict: 'approve', reasoning: 'lgtm' }),
      '```',
      '',
      'No further changes needed.',
    ].join('\n');
    expect(parseReviewerVerdict(text)).toEqual({
      verdict: 'approve',
      reasoning: 'lgtm',
      requestedChanges: [],
    });
  });

  it('accepts snake_case `requested_changes` as a JSON alias', () => {
    const text = JSON.stringify({
      verdict: 'request_changes',
      reasoning: 'x',
      requested_changes: ['a', 'b'],
    });
    expect(parseReviewerVerdict(text)?.requestedChanges).toEqual(['a', 'b']);
  });

  it('skips JSON objects without a verdict and falls back to the next match', () => {
    const text = [
      '{"unrelated": "object"}',
      '',
      JSON.stringify({ verdict: 'approve', reasoning: 'second block wins' }),
    ].join('\n');
    expect(parseReviewerVerdict(text)?.verdict).toBe('approve');
  });

  it('rejects an unknown verdict value rather than guessing', () => {
    const text = JSON.stringify({ verdict: 'looks_ok', reasoning: 'x' });
    expect(parseReviewerVerdict(text)).toBeNull();
  });
});

describe('parseReviewerVerdict — markdown-decorated output', () => {
  it('accepts bold-wrapped headers (**VERDICT:** approve)', () => {
    const text = ['**VERDICT:** approve', '**REASONING:** matches the plan'].join('\n');
    expect(parseReviewerVerdict(text)).toEqual({
      verdict: 'approve',
      reasoning: 'matches the plan',
      requestedChanges: [],
    });
  });

  it('accepts markdown-header style (## VERDICT: approve)', () => {
    const text = ['## VERDICT: approve', '## REASONING: looks good'].join('\n');
    expect(parseReviewerVerdict(text)?.verdict).toBe('approve');
  });

  it('accepts numbered-list bullets in REQUESTED_CHANGES', () => {
    const text = [
      'VERDICT: request_changes',
      'REASONING: two issues',
      'REQUESTED_CHANGES:',
      '1. add a null check',
      '2) cover the timeout path',
    ].join('\n');
    expect(parseReviewerVerdict(text)?.requestedChanges).toEqual([
      'add a null check',
      'cover the timeout path',
    ]);
  });

  it('accepts mixed case and inline prose', () => {
    const text = [
      'After reviewing the diff:',
      '',
      'Verdict: Approve',
      'Reasoning: The change is minimal and the validation steps from the plan would pass.',
    ].join('\n');
    expect(parseReviewerVerdict(text)?.verdict).toBe('approve');
  });
});

describe('parseReviewerVerdict — returns null on truly unparseable output', () => {
  it('returns null for empty input', () => {
    expect(parseReviewerVerdict('')).toBeNull();
    expect(parseReviewerVerdict('   \n\n')).toBeNull();
  });

  it('returns null for unrelated prose (no VERDICT keyword)', () => {
    expect(parseReviewerVerdict('Looks good to me, ship it!')).toBeNull();
  });

  it('does not approve on the strength of the word "approve" alone', () => {
    // No `VERDICT` token — prose containing the word "approve" must not
    // count as an approval. This is the safety property the parser has
    // to preserve through any robustness changes.
    expect(parseReviewerVerdict('I approve of this change.')).toBeNull();
    expect(parseReviewerVerdict('The maintainer may approve later.')).toBeNull();
  });

  it('returns null when VERDICT keyword present but value is hedged prose', () => {
    // "VERDICT: I think this should approve" — the strict value match
    // refuses anything that isn't exactly `approve` or `request_changes`.
    expect(parseReviewerVerdict('VERDICT: I think we should approve this.')).toBeNull();
  });
});
