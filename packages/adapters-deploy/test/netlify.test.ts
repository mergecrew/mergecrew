/**
 * Conformance test for the Netlify deploy adapter (V2.2 follow-up, #198).
 *
 * Same shape as `render.test.ts` — stub global fetch with Netlify's HTTP
 * payloads, drive each `DeployProvider` method, validate via the helpers
 * in `./conformance.ts`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NetlifyProvider } from '../src/netlify.js';
import {
  expectValidHandle,
  expectValidResult,
  expectValidStatus,
  jsonResponse,
  makeTarget,
} from './conformance.js';

const target = makeTarget('netlify', { siteId: 'site_abc' });
let provider: NetlifyProvider;

beforeEach(() => {
  provider = new NetlifyProvider({ token: 'nf_test' });
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

describe('NetlifyProvider — conformance', () => {
  it('triggerDeploy returns a well-shaped DeployHandle (using deploy_id when present)', async () => {
    stubFetchOnce(jsonResponse({ id: 'build_xxx', deploy_id: 'dep_yyy' }));
    const handle = await provider.triggerDeploy(target, {
      ref: 'sha123',
      branch: 'main',
      correlationId: 'corr-1',
    });
    expectValidHandle(handle, { targetId: target.id, correlationId: 'corr-1' });
    expect(handle.externalRunId).toBe('dep_yyy');
  });

  it('triggerDeploy falls back to build id when deploy_id is absent', async () => {
    stubFetchOnce(jsonResponse({ id: 'build_xxx' }));
    const handle = await provider.triggerDeploy(target, {
      ref: 'sha',
      branch: 'main',
      correlationId: 'c',
    });
    expect(handle.externalRunId).toBe('build_xxx');
  });

  it('getStatus maps every documented backend state to a valid DeployStatus', async () => {
    const cases: Array<{ state: string; expectedKind: string }> = [
      { state: 'new', expectedKind: 'queued' },
      { state: 'enqueued', expectedKind: 'queued' },
      { state: 'building', expectedKind: 'in_progress' },
      { state: 'uploading', expectedKind: 'in_progress' },
      { state: 'processing', expectedKind: 'in_progress' },
      { state: 'prepared', expectedKind: 'in_progress' },
      { state: 'uploaded', expectedKind: 'in_progress' },
      { state: 'ready', expectedKind: 'success' },
      { state: 'error', expectedKind: 'failed' },
    ];
    for (const c of cases) {
      stubFetchOnce(
        jsonResponse({
          state: c.state,
          deploy_ssl_url: 'https://acme.netlify.app',
          published_at: '2026-05-10T00:00:00Z',
          updated_at: '2026-05-10T00:00:00Z',
          error_message: c.state === 'error' ? 'build failed' : undefined,
        }),
      );
      const s = await provider.getStatus({
        externalRunId: 'dep_yyy',
        targetId: target.id,
        correlationId: 'c',
      });
      expect(s.kind, `state=${c.state}`).toBe(c.expectedKind);
      expectValidStatus(s);
    }
  });

  it('awaitCompletion returns success when the first poll already shows the deploy ready', async () => {
    stubFetchOnce(
      jsonResponse({
        state: 'ready',
        deploy_ssl_url: 'https://acme.netlify.app',
        published_at: '2026-05-10T00:00:00Z',
      }),
    );
    const result = await provider.awaitCompletion(
      { externalRunId: 'dep_yyy', targetId: target.id, correlationId: 'c' },
      30_000,
      new AbortController().signal,
    );
    expectValidResult(result);
    expect(result.status.kind).toBe('success');
    expect(result.url).toBe('https://acme.netlify.app');
  });

  it('awaitCompletion bounds total runtime by timeoutMs', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ state: 'building' })),
    );
    const start = Date.now();
    const result = await provider.awaitCompletion(
      { externalRunId: 'dep_yyy', targetId: target.id, correlationId: 'c' },
      200,
      new AbortController().signal,
    );
    expect(Date.now() - start).toBeLessThan(2_000);
    expectValidResult(result);
    expect(result.status.kind).toBe('failed');
  });

  it('resolveUrlForRef returns null when no deploy matches', async () => {
    stubFetchOnce(jsonResponse([]));
    const url = await provider.resolveUrlForRef(target, 'unknown-sha');
    expect(url).toBeNull();
  });

  it('resolveUrlForRef returns the ssl URL when a deploy matches by commit_ref', async () => {
    stubFetchOnce(
      jsonResponse([
        { commit_ref: 'sha-match', deploy_ssl_url: 'https://acme-preview.netlify.app' },
      ]),
    );
    const url = await provider.resolveUrlForRef(target, 'sha-match');
    expect(url).toBe('https://acme-preview.netlify.app');
  });

  it('fetchLogs returns an array (Netlify adapter currently returns empty)', async () => {
    const logs = await provider.fetchLogs(
      { externalRunId: 'dep_yyy', targetId: target.id, correlationId: 'c' },
      { tailLines: 100 },
    );
    expect(Array.isArray(logs)).toBe(true);
  });

  it('rollbackProduction returns a well-shaped DeployHandle on a matching sha', async () => {
    stubFetchOnce(
      jsonResponse([
        { id: 'dep_old', commit_ref: 'old-sha', state: 'ready' },
      ]),
      jsonResponse({ id: 'dep_restored' }),
    );
    const handle = await provider.rollbackProduction(target, 'old-sha');
    expect(handle.externalRunId).toBe('dep_restored');
    expect(handle.targetId).toBe(target.id);
    expect(typeof handle.correlationId).toBe('string');
  });

  it('rollbackProduction throws when no ready deploy matches the sha', async () => {
    stubFetchOnce(jsonResponse([{ id: 'dep_x', commit_ref: 'old-sha', state: 'building' }]));
    await expect(provider.rollbackProduction(target, 'old-sha')).rejects.toThrow(
      /no ready deploy/,
    );
  });

  it('throws on a non-2xx HTTP response', async () => {
    stubFetchOnce(new Response('boom', { status: 500 }));
    await expect(
      provider.triggerDeploy(target, { ref: 'sha', branch: 'main', correlationId: 'c' }),
    ).rejects.toThrow(/netlify 500/);
  });
});

describe('NetlifyProvider — surface', () => {
  it('exposes id "netlify"', () => {
    expect(provider.id).toBe('netlify');
  });
});
