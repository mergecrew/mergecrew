/**
 * parseDesignReviewVerdict covers the DesignReviewer output contract
 * (#522). The runner's post-process reads the parsed verdict to gate
 * a future `DESIGN_REVIEW_VERDICT` event; a parser regression either
 * dead-ends the run-detail UI's visual-regression chip or false-flags
 * working screenshots as regressions.
 */
import { describe, expect, it } from 'vitest';
import { parseDesignReviewVerdict } from '../src/loop.js';

describe('parseDesignReviewVerdict — canonical shape', () => {
  it('parses looks_correct with a single finding', () => {
    const text = [
      'VERDICT: looks_correct',
      'SCREENSHOT_URL: s3://mc/runs/run-1/design.png',
      'FINDINGS:',
      '- layout matches the design brief',
    ].join('\n');
    expect(parseDesignReviewVerdict(text)).toEqual({
      verdict: 'looks_correct',
      screenshotUrl: 's3://mc/runs/run-1/design.png',
      findings: ['layout matches the design brief'],
    });
  });

  it('parses visual_regression with multiple findings', () => {
    const text = [
      'VERDICT: visual_regression',
      'SCREENSHOT_URL: https://dev.example.com/screenshot.png',
      'FINDINGS:',
      '- header logo overflows the container at desktop width',
      '- primary CTA wraps to two lines on the hero section',
    ].join('\n');
    expect(parseDesignReviewVerdict(text)).toEqual({
      verdict: 'visual_regression',
      screenshotUrl: 'https://dev.example.com/screenshot.png',
      findings: [
        'header logo overflows the container at desktop width',
        'primary CTA wraps to two lines on the hero section',
      ],
    });
  });
});

describe('parseDesignReviewVerdict — tolerant of common LLM drift', () => {
  it('accepts a JSON envelope', () => {
    const text = `\`\`\`json
{ "verdict": "visual_regression", "screenshotUrl": "s3://x/y.png", "findings": ["a", "b"] }
\`\`\``;
    expect(parseDesignReviewVerdict(text)).toEqual({
      verdict: 'visual_regression',
      screenshotUrl: 's3://x/y.png',
      findings: ['a', 'b'],
    });
  });

  it('accepts the snake_case `screenshot_url` JSON alias', () => {
    const text = '{"verdict":"looks_correct","screenshot_url":"file:///tmp/x.png","findings":[]}';
    expect(parseDesignReviewVerdict(text)?.screenshotUrl).toBe('file:///tmp/x.png');
  });

  it('accepts markdown-decorated keywords', () => {
    const text = [
      '**VERDICT:** looks_correct',
      '**SCREENSHOT_URL:** file:///tmp/snap.png',
      '**FINDINGS:**',
      '- nothing notable',
    ].join('\n');
    expect(parseDesignReviewVerdict(text)?.verdict).toBe('looks_correct');
  });

  it('accepts numbered FINDINGS bullets', () => {
    const text = [
      'VERDICT: visual_regression',
      'SCREENSHOT_URL: s3://x.png',
      'FINDINGS:',
      '1. a',
      '2) b',
    ].join('\n');
    expect(parseDesignReviewVerdict(text)?.findings).toEqual(['a', 'b']);
  });

  it('parses the no-vision fallback verdict the prompt prescribes', () => {
    const text = [
      'VERDICT: looks_correct',
      'SCREENSHOT_URL: ',
      'FINDINGS:',
      '- vision not available',
    ].join('\n');
    expect(parseDesignReviewVerdict(text)).toEqual({
      verdict: 'looks_correct',
      screenshotUrl: '',
      findings: ['vision not available'],
    });
  });
});

describe('parseDesignReviewVerdict — returns null on truly unparseable output', () => {
  it('returns null for empty input', () => {
    expect(parseDesignReviewVerdict('')).toBeNull();
    expect(parseDesignReviewVerdict('  \n  ')).toBeNull();
  });

  it('returns null when the verdict value is not one of the two allowed', () => {
    expect(parseDesignReviewVerdict('VERDICT: dunno\nFINDINGS:\n- shrug')).toBeNull();
  });

  it('returns null when there is no VERDICT line', () => {
    expect(parseDesignReviewVerdict('Looks fine to me.')).toBeNull();
  });
});
