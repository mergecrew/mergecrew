/**
 * parseBugTriageReport covers the BugTriage agent output contract
 * (#524). The runner creates one intent_inbox_item per parsed
 * intent (with `bug-triage:<fingerprint>` source-key dedup), so a
 * parser regression either drops follow-up work on the floor or
 * spawns ghost intents that distract tomorrow's PM.
 */
import { describe, expect, it } from 'vitest';
import { parseBugTriageReport } from '../src/loop.js';

describe('parseBugTriageReport — canonical shape (matches BUG_TRIAGE_SYSTEM_PROMPT)', () => {
  it('parses scanned + intents from a JSON code fence', () => {
    const text = `Here is what I found.

\`\`\`json
{
  "scanned": 12,
  "intents": [
    {
      "title": "TypeError in payment flow",
      "fingerprint": "sentry-fp-abc123",
      "body": "Stack:\\n  at apps/api/src/billing/charge.ts:42"
    },
    {
      "title": "DB connection timeout",
      "fingerprint": "sentry-fp-def456",
      "body": "Affected: apps/api/src/db.ts"
    }
  ]
}
\`\`\``;
    expect(parseBugTriageReport(text)).toEqual({
      scanned: 12,
      intents: [
        {
          title: 'TypeError in payment flow',
          fingerprint: 'sentry-fp-abc123',
          body: 'Stack:\n  at apps/api/src/billing/charge.ts:42',
        },
        {
          title: 'DB connection timeout',
          fingerprint: 'sentry-fp-def456',
          body: 'Affected: apps/api/src/db.ts',
        },
      ],
    });
  });

  it('parses the zero-intent "nothing new" report', () => {
    const text = '```json\n{"scanned": 8, "intents": []}\n```';
    expect(parseBugTriageReport(text)).toEqual({ scanned: 8, intents: [] });
  });
});

describe('parseBugTriageReport — tolerant of common LLM drift', () => {
  it('accepts bare JSON without a code fence', () => {
    const text = '{"scanned":3,"intents":[{"title":"x","fingerprint":"fp1","body":""}]}';
    expect(parseBugTriageReport(text)?.intents).toEqual([
      { title: 'x', fingerprint: 'fp1', body: '' },
    ]);
  });

  it('accepts the snake_case `error_fingerprint` field alias', () => {
    const text = '{"scanned":1,"intents":[{"title":"x","error_fingerprint":"fp1","body":""}]}';
    expect(parseBugTriageReport(text)?.intents?.[0]?.fingerprint).toBe('fp1');
  });

  it('accepts the `errorsScanned` alias for the scanned field', () => {
    const text = '{"errorsScanned":5,"intents":[]}';
    expect(parseBugTriageReport(text)?.scanned).toBe(5);
  });

  it('skips intent entries missing a title', () => {
    const text = '{"scanned":2,"intents":[{"fingerprint":"fp1"},{"title":"ok","fingerprint":"fp2","body":""}]}';
    const r = parseBugTriageReport(text);
    expect(r?.intents.length).toBe(1);
    expect(r?.intents[0]?.title).toBe('ok');
  });

  it('coerces a string-typed scanned value to a number', () => {
    const text = '{"scanned":"7","intents":[]}';
    expect(parseBugTriageReport(text)?.scanned).toBe(7);
  });

  it('handles prose around the JSON envelope', () => {
    const text =
      'I scanned the last hour of errors. Report below.\n\n```json\n{"scanned":1,"intents":[]}\n```\n\nNothing new compared to yesterday.';
    expect(parseBugTriageReport(text)?.scanned).toBe(1);
  });
});

describe('parseBugTriageReport — returns null on truly unparseable output', () => {
  it('returns null for empty input', () => {
    expect(parseBugTriageReport('')).toBeNull();
    expect(parseBugTriageReport('  \n  ')).toBeNull();
  });

  it('returns null when no JSON envelope is present', () => {
    expect(parseBugTriageReport('I checked the errors. Nothing new.')).toBeNull();
  });

  it('returns null when the JSON object has no `intents` field at all', () => {
    // Without `intents`, we cannot distinguish "empty scan" from
    // "wrong shape" — be strict and return null.
    expect(parseBugTriageReport('{"scanned": 5}')).toBeNull();
  });
});
