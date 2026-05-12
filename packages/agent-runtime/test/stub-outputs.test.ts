/**
 * Stub-agent output contract tests (#371).
 *
 * The V2.ae careful chain reads agent outputs via `parsePlanPaths`
 * (planner) and `parseReviewerVerdict` (reviewer). If `MERGECREW_AGENT_STUB`
 * mode emits something those parsers reject, the demo-mode chain
 * silently breaks: the orchestrator falls back to its defaults and the
 * UI doesn't show the right events. Lock the contract in.
 */
import { describe, expect, it } from 'vitest';
import {
  parsePlanPaths,
  parseReviewerVerdict,
  STUB_PLAN_MARKDOWN,
  STUB_REVIEWER_APPROVE,
  STUB_REVIEWER_REQUEST_CHANGES,
} from '../src/loop.js';

describe('stub planner output (#371)', () => {
  it('parses cleanly via parsePlanPaths', () => {
    const result = parsePlanPaths(STUB_PLAN_MARKDOWN);
    expect(result).not.toBeNull();
  });

  it('lists at least one "Files to touch" entry', () => {
    const result = parsePlanPaths(STUB_PLAN_MARKDOWN)!;
    expect(result.filesToTouch.length).toBeGreaterThan(0);
  });

  it('lists at least one "Files NOT to touch" entry (out-of-scope guard test fodder)', () => {
    const result = parsePlanPaths(STUB_PLAN_MARKDOWN)!;
    expect(result.filesNotToTouch.length).toBeGreaterThan(0);
  });
});

describe('stub reviewer output (#371)', () => {
  it('approve verdict parses to verdict=approve', () => {
    const result = parseReviewerVerdict(STUB_REVIEWER_APPROVE);
    expect(result).not.toBeNull();
    expect(result!.verdict).toBe('approve');
    expect(result!.reasoning.length).toBeGreaterThan(0);
  });

  it('request_changes verdict parses to verdict=request_changes with non-empty requestedChanges', () => {
    const result = parseReviewerVerdict(STUB_REVIEWER_REQUEST_CHANGES);
    expect(result).not.toBeNull();
    expect(result!.verdict).toBe('request_changes');
    expect(result!.requestedChanges.length).toBeGreaterThan(0);
  });
});
