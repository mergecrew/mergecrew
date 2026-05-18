/**
 * parseObservationReport covers the Observation agent output contract
 * (#523). The runner persists the parsed verdict + status code +
 * latency on `agent_steps.output`; a regression either dead-ends the
 * run-detail UI's health chip or false-positives a rollback intent.
 */
import { describe, expect, it } from 'vitest';
import { parseObservationReport } from '../src/loop.js';

describe('parseObservationReport — canonical shape', () => {
  it('parses healthy with status / latency / findings', () => {
    const text = [
      'VERDICT: healthy',
      'STATUS_CODE: 200',
      'LATENCY_MS: 142',
      'FINDINGS:',
      '- HTTP 2xx, body contains expected keywords',
    ].join('\n');
    expect(parseObservationReport(text)).toEqual({
      verdict: 'healthy',
      statusCode: 200,
      latencyMs: 142,
      findings: ['HTTP 2xx, body contains expected keywords'],
    });
  });

  it('parses unhealthy with multiple failure findings', () => {
    const text = [
      'VERDICT: unhealthy',
      'STATUS_CODE: 500',
      'LATENCY_MS: 8421',
      'FINDINGS:',
      '- HTTP 500 from /healthz',
      '- response body missing mustContain string "ok"',
    ].join('\n');
    expect(parseObservationReport(text)).toEqual({
      verdict: 'unhealthy',
      statusCode: 500,
      latencyMs: 8421,
      findings: [
        'HTTP 500 from /healthz',
        'response body missing mustContain string "ok"',
      ],
    });
  });
});

describe('parseObservationReport — tolerant of common LLM drift', () => {
  it('accepts a JSON envelope', () => {
    const text = `\`\`\`json
{ "verdict": "unhealthy", "statusCode": 502, "latencyMs": 1000, "findings": ["bad gateway"] }
\`\`\``;
    expect(parseObservationReport(text)).toEqual({
      verdict: 'unhealthy',
      statusCode: 502,
      latencyMs: 1000,
      findings: ['bad gateway'],
    });
  });

  it('accepts snake_case JSON aliases', () => {
    const text = '{"verdict":"healthy","status_code":204,"latency_ms":50,"findings":[]}';
    expect(parseObservationReport(text)).toEqual({
      verdict: 'healthy',
      statusCode: 204,
      latencyMs: 50,
      findings: [],
    });
  });

  it('accepts markdown-decorated keywords', () => {
    const text = [
      '**VERDICT:** healthy',
      '**STATUS_CODE:** 200',
      '**LATENCY_MS:** 87',
      '**FINDINGS:**',
      '- looks good',
    ].join('\n');
    expect(parseObservationReport(text)?.verdict).toBe('healthy');
  });

  it('parses the no-deploy fallback verdict the prompt prescribes', () => {
    const text = [
      'VERDICT: healthy',
      'STATUS_CODE: 0',
      'LATENCY_MS: 0',
      'FINDINGS:',
      '- no dev deploy',
    ].join('\n');
    expect(parseObservationReport(text)).toEqual({
      verdict: 'healthy',
      statusCode: 0,
      latencyMs: 0,
      findings: ['no dev deploy'],
    });
  });

  it('coerces numeric fields parsed from string-typed JSON values', () => {
    const text = '{"verdict":"unhealthy","statusCode":"503","latencyMs":"1234","findings":["x"]}';
    expect(parseObservationReport(text)).toEqual({
      verdict: 'unhealthy',
      statusCode: 503,
      latencyMs: 1234,
      findings: ['x'],
    });
  });
});

describe('parseObservationReport — returns null on truly unparseable output', () => {
  it('returns null for empty input', () => {
    expect(parseObservationReport('')).toBeNull();
    expect(parseObservationReport('  \n  ')).toBeNull();
  });

  it('returns null when the verdict value is not one of the two allowed', () => {
    expect(parseObservationReport('VERDICT: yellow\nFINDINGS:\n- meh')).toBeNull();
  });

  it('returns null when there is no VERDICT line', () => {
    expect(parseObservationReport('Page loaded fine, I think.')).toBeNull();
  });
});
