/**
 * Conformance test for the Vercel deploy adapter (V2.2 follow-up, #198).
 *
 * Same shape as `render.test.ts` — stub global fetch with Vercel's HTTP
 * payloads, drive each `DeployProvider` method, validate via the helpers
 * in `./conformance.ts`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VercelProvider } from '../src/vercel.js';
import {
  expectValidHandle,
  expectValidResult,
  expectValidStatus,
  jsonResponse,
  makeTarget,
} from './conformance.js';

const target = makeTarget('vercel', {
  projectId: 'prj_test',
  target: 'preview',
  repoSlug: 'acme/web',
});
let provider: VercelProvider;

beforeEach(() => {
  provider = new VercelProvider({ token: 'vc_test' });
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

describe('VercelProvider — conformance', () => {
  it('triggerDeploy returns a well-shaped DeployHandle', async () => {
    stubFetchOnce(jsonResponse({ id: 'dpl_xyz' }));
    const handle = await provider.triggerDeploy(target, {
      ref: 'sha123',
      branch: 'main',
      correlationId: 'corr-1',
    });
    expectValidHandle(handle, { targetId: target.id, correlationId: 'corr-1' });
    expect(handle.externalRunId).toBe('dpl_xyz');
  });

  it('getStatus maps every documented readyState to a valid DeployStatus', async () => {
    const cases: Array<{ readyState: string; expectedKind: string }> = [
      { readyState: 'QUEUED', expectedKind: 'queued' },
      { readyState: 'INITIALIZING', expectedKind: 'in_progress' },
      { readyState: 'BUILDING', expectedKind: 'in_progress' },
      { readyState: 'READY', expectedKind: 'success' },
      { readyState: 'ERROR', expectedKind: 'failed' },
      { readyState: 'CANCELED', expectedKind: 'cancelled' },
    ];
    for (const c of cases) {
      stubFetchOnce(
        jsonResponse({
          readyState: c.readyState,
          url: 'web-acme.vercel.app',
          ready: '2026-05-10T00:00:00Z',
          errorMessage: c.readyState === 'ERROR' ? 'build failed' : undefined,
        }),
      );
      const s = await provider.getStatus({
        externalRunId: 'dpl_xyz',
        targetId: target.id,
        correlationId: 'c',
      });
      expect(s.kind, `readyState=${c.readyState}`).toBe(c.expectedKind);
      expectValidStatus(s);
    }
  });

  it('awaitCompletion returns success when the first poll already shows the deploy ready', async () => {
    stubFetchOnce(
      jsonResponse({
        readyState: 'READY',
        url: 'web-acme.vercel.app',
        ready: '2026-05-10T00:00:00Z',
      }),
    );
    const result = await provider.awaitCompletion(
      { externalRunId: 'dpl_xyz', targetId: target.id, correlationId: 'c' },
      30_000,
      new AbortController().signal,
    );
    expectValidResult(result);
    expect(result.status.kind).toBe('success');
    expect(result.url).toBe('https://web-acme.vercel.app');
  });

  it('awaitCompletion bounds total runtime by timeoutMs', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ readyState: 'BUILDING' })),
    );
    const start = Date.now();
    const result = await provider.awaitCompletion(
      { externalRunId: 'dpl_xyz', targetId: target.id, correlationId: 'c' },
      200,
      new AbortController().signal,
    );
    expect(Date.now() - start).toBeLessThan(2_000);
    expectValidResult(result);
    expect(result.status.kind).toBe('failed');
  });

  it('resolveUrlForRef returns null when no deploy matches the ref', async () => {
    stubFetchOnce(jsonResponse({ deployments: [] }));
    const url = await provider.resolveUrlForRef(target, 'unknown-sha');
    expect(url).toBeNull();
  });

  it('resolveUrlForRef returns a string URL when a deploy matches by sha', async () => {
    stubFetchOnce(
      jsonResponse({
        deployments: [
          { url: 'web-acme-abcd.vercel.app', meta: { githubCommitSha: 'sha-match' } },
        ],
      }),
    );
    const url = await provider.resolveUrlForRef(target, 'sha-match');
    expect(url).toBe('https://web-acme-abcd.vercel.app');
  });

  it('fetchLogs returns parsed LogChunks', async () => {
    stubFetchOnce(
      jsonResponse([
        { created: '2026-05-10T00:00:00Z', text: 'building' },
        { created: '2026-05-10T00:00:01Z', payload: { text: 'deploying' } },
      ]),
    );
    const logs = await provider.fetchLogs(
      { externalRunId: 'dpl_xyz', targetId: target.id, correlationId: 'c' },
      { tailLines: 10 },
    );
    expect(Array.isArray(logs)).toBe(true);
    expect(logs.length).toBe(2);
    expect(logs[0]?.line).toBe('building');
    expect(logs[1]?.line).toBe('deploying');
  });

  it('rollbackProduction returns a well-shaped DeployHandle on a matching sha', async () => {
    stubFetchOnce(
      jsonResponse({
        deployments: [
          { uid: 'dpl_old', meta: { githubCommitSha: 'old-sha' } },
        ],
      }),
      jsonResponse({}),
    );
    const handle = await provider.rollbackProduction(target, 'old-sha');
    expect(handle.externalRunId).toBe('dpl_old');
    expect(handle.targetId).toBe(target.id);
    expect(typeof handle.correlationId).toBe('string');
  });

  it('rollbackProduction throws when no deployment matches the sha', async () => {
    stubFetchOnce(jsonResponse({ deployments: [] }));
    await expect(provider.rollbackProduction(target, 'no-such-sha')).rejects.toThrow(
      /no deployment with sha/,
    );
  });

  it('throws on a non-2xx HTTP response', async () => {
    stubFetchOnce(new Response('boom', { status: 500 }));
    await expect(
      provider.triggerDeploy(target, { ref: 'sha', branch: 'main', correlationId: 'c' }),
    ).rejects.toThrow(/vercel 500/);
  });
});

describe('VercelProvider — surface', () => {
  it('exposes id "vercel"', () => {
    expect(provider.id).toBe('vercel');
  });
});
