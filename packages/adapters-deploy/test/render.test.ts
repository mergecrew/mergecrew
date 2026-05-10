/**
 * Reference conformance test for the Render deploy adapter (V2.2, #26).
 *
 * This file is the template new adapter authors should copy: stub global
 * fetch with the vendor-specific HTTP shape, drive each `DeployProvider`
 * method through a representative scenario, and validate the runtime
 * contract via the helpers in `./conformance.ts`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RenderProvider } from '../src/render.js';
import {
  emptyResponse,
  expectValidHandle,
  expectValidResult,
  expectValidStatus,
  jsonResponse,
  makeTarget,
} from './conformance.js';

const target = makeTarget('render', { serviceId: 'srv-abc' });
let provider: RenderProvider;

beforeEach(() => {
  provider = new RenderProvider({ token: 'rnd_test' });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubFetchOnce(...responses: Response[]): ReturnType<typeof vi.fn> {
  const queue = [...responses];
  const fn = vi.fn(async () => queue.shift() ?? jsonResponse({}, { status: 500 }));
  vi.stubGlobal('fetch', fn);
  return fn;
}

describe('RenderProvider — conformance', () => {
  it('triggerDeploy returns a well-shaped DeployHandle', async () => {
    stubFetchOnce(jsonResponse({ id: 'dep_abc' }));
    const handle = await provider.triggerDeploy(target, {
      ref: 'sha123',
      branch: 'main',
      correlationId: 'corr-1',
    });
    expectValidHandle(handle, { targetId: target.id, correlationId: 'corr-1' });
    expect(handle.externalRunId).toBe('dep_abc');
  });

  it('getStatus maps every documented backend state to a valid DeployStatus', async () => {
    const cases: Array<{ backend: string; expectedKind: string }> = [
      { backend: 'created', expectedKind: 'queued' },
      { backend: 'queued', expectedKind: 'queued' },
      { backend: 'build_in_progress', expectedKind: 'in_progress' },
      { backend: 'pre_deploy_in_progress', expectedKind: 'in_progress' },
      { backend: 'update_in_progress', expectedKind: 'in_progress' },
      { backend: 'live', expectedKind: 'success' },
      { backend: 'build_failed', expectedKind: 'failed' },
      { backend: 'pre_deploy_failed', expectedKind: 'failed' },
      { backend: 'update_failed', expectedKind: 'failed' },
      { backend: 'canceled', expectedKind: 'cancelled' },
    ];
    for (const c of cases) {
      stubFetchOnce(
        jsonResponse({
          status: c.backend,
          url: 'https://x.onrender.com',
          finishedAt: '2026-05-10T00:00:00Z',
        }),
      );
      const s = await provider.getStatus({
        externalRunId: 'dep_abc',
        targetId: target.id,
        correlationId: 'c',
      });
      expect(s.kind, `backend=${c.backend}`).toBe(c.expectedKind);
      expectValidStatus(s);
    }
  });

  it('awaitCompletion returns success when the first poll already shows the deploy live', async () => {
    // First poll already terminal — keeps the test fast (no 4s sleep
    // through the polling backoff). Multi-poll behavior is exercised by
    // the live integration smoke (`apps/dogfood-smoke`).
    stubFetchOnce(
      jsonResponse({
        status: 'live',
        url: 'https://x.onrender.com',
        finishedAt: '2026-05-10T00:00:00Z',
      }),
    );
    const result = await provider.awaitCompletion(
      { externalRunId: 'dep_abc', targetId: target.id, correlationId: 'c' },
      30_000,
      new AbortController().signal,
    );
    expectValidResult(result);
    expect(result.status.kind).toBe('success');
    expect(result.url).toBe('https://x.onrender.com');
  });

  it('awaitCompletion bounds total runtime by timeoutMs even when the deploy never finishes', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ status: 'build_in_progress' })),
    );
    const start = Date.now();
    const result = await provider.awaitCompletion(
      { externalRunId: 'dep_abc', targetId: target.id, correlationId: 'c' },
      200, // small timeout — render's sleep is `Math.min(delay, deadline - now)`
      new AbortController().signal,
    );
    // Allow some scheduler slop on macOS / CI runners.
    expect(Date.now() - start).toBeLessThan(2_000);
    expectValidResult(result);
    expect(result.status.kind).toBe('failed');
  });

  it('resolveUrlForRef returns null when no deploy matches the ref', async () => {
    stubFetchOnce(jsonResponse({ deploys: [] }));
    const url = await provider.resolveUrlForRef(target, 'unknown-sha');
    expect(url).toBeNull();
  });

  it('resolveUrlForRef returns a string URL when a deploy matches', async () => {
    stubFetchOnce(
      jsonResponse({
        deploys: [
          {
            deploy: {
              commit: { id: 'sha-match' },
              url: 'https://my-service.onrender.com',
            },
          },
        ],
      }),
    );
    const url = await provider.resolveUrlForRef(target, 'sha-match');
    expect(url).toBe('https://my-service.onrender.com');
  });

  it('fetchLogs returns an array (Render adapter currently returns empty)', async () => {
    const logs = await provider.fetchLogs(
      { externalRunId: 'dep_abc', targetId: target.id, correlationId: 'c' },
      { tailLines: 100 },
    );
    expect(Array.isArray(logs)).toBe(true);
  });

  it('rollbackProduction returns a well-shaped DeployHandle', async () => {
    stubFetchOnce(jsonResponse({ id: 'dep_rollback' }));
    const handle = await provider.rollbackProduction(target, 'old-sha');
    expect(handle.externalRunId).toBe('dep_rollback');
    expect(handle.targetId).toBe(target.id);
    // rollback synthesizes its own correlationId; just assert it's a string.
    expect(typeof handle.correlationId).toBe('string');
  });

  it('throws on a non-2xx HTTP response', async () => {
    stubFetchOnce(new Response('boom', { status: 500 }));
    await expect(
      provider.triggerDeploy(target, { ref: 'sha', branch: 'main', correlationId: 'c' }),
    ).rejects.toThrow(/render 500/);
  });
});

// Sanity: the package's public adapter `id` must match what the type union
// in `types.ts` allows. If a contributor adds a new id, both spots have to
// stay in sync; this catches a stale type drift.
describe('RenderProvider — surface', () => {
  it('exposes id "render"', () => {
    expect(provider.id).toBe('render');
  });
});

// Suppress unused-import warning for emptyResponse — it's exported from
// the conformance helpers for adapters whose endpoints return 204.
void emptyResponse;
