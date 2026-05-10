/**
 * Behavioral conformance helpers for `DeployProvider` adapters (V2.2, #26).
 *
 * Each adapter targets a different vendor API but must satisfy the same
 * runtime contract — return the right `DeployStatus` discriminator,
 * honor abort signals on `awaitCompletion`, etc. These helpers exist so
 * a per-adapter test file (`render.test.ts`, `vercel.test.ts`, …) can
 * focus on wiring up the right HTTP-level mocks and reuse the assertions.
 *
 * The reference test is `render.test.ts`; new-adapter authors copy that
 * file, swap the fetch responses for their vendor's shape, and the
 * helpers below catch contract violations the same way.
 */

import { expect } from 'vitest';
import type { DeployHandle, DeployResult, DeployStatus, DeployTargetRef } from '../src/types.js';

const VALID_STATUS_KINDS = ['queued', 'in_progress', 'success', 'failed', 'cancelled'] as const;

/**
 * Build a `Response` with a JSON body. Saves boilerplate in adapter
 * test fixtures.
 */
export function jsonResponse(body: unknown, init: { status?: number } = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json' },
  });
}

export function emptyResponse(status = 204): Response {
  return new Response(null, { status });
}

/**
 * Make a `target: DeployTargetRef` for tests. Adapters cast `target.config`
 * to their vendor-specific shape, so the caller passes that in.
 */
export function makeTarget(adapterId: string, config: Record<string, unknown>): DeployTargetRef {
  return { id: 'target-test', kind: 'dev', adapterId, config };
}

export function expectValidHandle(
  handle: DeployHandle,
  expected: { targetId: string; correlationId: string },
): void {
  expect(typeof handle.externalRunId).toBe('string');
  expect(handle.externalRunId.length).toBeGreaterThan(0);
  expect(handle.targetId).toBe(expected.targetId);
  expect(handle.correlationId).toBe(expected.correlationId);
}

export function expectValidStatus(s: DeployStatus): void {
  expect(VALID_STATUS_KINDS).toContain(s.kind);
  if (s.kind === 'success') {
    expect(typeof s.url).toBe('string');
    expect(typeof s.finishedAt).toBe('string');
  }
  if (s.kind === 'failed') {
    expect(typeof s.reason).toBe('string');
    expect(typeof s.finishedAt).toBe('string');
  }
}

export function expectValidResult(r: DeployResult): void {
  expectValidStatus(r.status);
}
