/**
 * parseDocWriterReport covers the DocWriter agent output contract
 * (#525). The runner persists the parsed verdict on
 * `agent_steps.output` and emits DOC_WRITER_REPORT. A parser
 * regression either drops the docs follow-up off the timeline or
 * false-positives a `docs_updated` chip on a no-op run.
 */
import { describe, expect, it } from 'vitest';
import { parseDocWriterReport } from '../src/loop.js';

describe('parseDocWriterReport — canonical shape (matches DOC_WRITER_SYSTEM_PROMPT)', () => {
  it('parses docs_updated with files + summary', () => {
    const text = [
      'VERDICT: docs_updated',
      'FILES_CHANGED:',
      '- README.md',
      '- docs/api/healthz.md',
      'SUMMARY: Added the /healthz endpoint to the public API reference.',
    ].join('\n');
    expect(parseDocWriterReport(text)).toEqual({
      verdict: 'docs_updated',
      filesChanged: ['README.md', 'docs/api/healthz.md'],
      summary: 'Added the /healthz endpoint to the public API reference.',
    });
  });

  it('parses the no_op shape', () => {
    const text = [
      'VERDICT: no_op',
      'SUMMARY: Refactor only — no user-facing surface changed.',
    ].join('\n');
    expect(parseDocWriterReport(text)).toEqual({
      verdict: 'no_op',
      filesChanged: [],
      summary: 'Refactor only — no user-facing surface changed.',
    });
  });
});

describe('parseDocWriterReport — tolerant of common LLM drift', () => {
  it('accepts a JSON envelope', () => {
    const text = `\`\`\`json
{
  "verdict": "docs_updated",
  "filesChanged": ["README.md"],
  "summary": "fix typo in install instructions"
}
\`\`\``;
    expect(parseDocWriterReport(text)).toEqual({
      verdict: 'docs_updated',
      filesChanged: ['README.md'],
      summary: 'fix typo in install instructions',
    });
  });

  it('accepts the snake_case `files_changed` JSON alias', () => {
    const text = '{"verdict":"docs_updated","files_changed":["a.md"],"summary":"s"}';
    expect(parseDocWriterReport(text)?.filesChanged).toEqual(['a.md']);
  });

  it('accepts markdown-decorated keywords', () => {
    const text = [
      '**VERDICT:** no_op',
      '**SUMMARY:** Nothing user-visible.',
    ].join('\n');
    expect(parseDocWriterReport(text)?.verdict).toBe('no_op');
  });

  it('accepts numbered FILES_CHANGED bullets', () => {
    const text = [
      'VERDICT: docs_updated',
      'FILES_CHANGED:',
      '1. README.md',
      '2) docs/foo.md',
      'SUMMARY: x',
    ].join('\n');
    expect(parseDocWriterReport(text)?.filesChanged).toEqual(['README.md', 'docs/foo.md']);
  });

  it('handles a docs_updated report with an empty FILES_CHANGED block', () => {
    // The agent meant to call out docs work but listed nothing — we
    // surface the verdict + summary anyway, the run-detail UI handles
    // the empty-files render.
    const text = [
      'VERDICT: docs_updated',
      'FILES_CHANGED:',
      'SUMMARY: rewrote tone of CONTRIBUTING.md, no path counted',
    ].join('\n');
    const r = parseDocWriterReport(text);
    expect(r?.verdict).toBe('docs_updated');
    expect(r?.filesChanged).toEqual([]);
  });
});

describe('parseDocWriterReport — returns null on truly unparseable output', () => {
  it('returns null for empty input', () => {
    expect(parseDocWriterReport('')).toBeNull();
    expect(parseDocWriterReport('  \n  ')).toBeNull();
  });

  it('returns null when the verdict value is not one of the two allowed', () => {
    expect(parseDocWriterReport('VERDICT: maybe\nSUMMARY: shrug')).toBeNull();
  });

  it('returns null when there is no VERDICT line', () => {
    expect(parseDocWriterReport('I considered the changes; nothing for docs.')).toBeNull();
  });
});
