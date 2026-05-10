/**
 * Conformance test for the Railway deploy adapter (#200).
 *
 * Railway is GraphQL-only, so the fetch responses are GraphQL response
 * envelopes (`{ data: { ... } }` / `{ errors: [...] }`). The contract
 * assertions from `./conformance.ts` work the same as the REST-based
 * adapters.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RailwayProvider } from '../src/railway.js';
import {
  expectValidHandle,
  expectValidResult,
  expectValidStatus,
  jsonResponse,
  makeTarget,
} from './conformance.js';

const target = makeTarget('railway', {
  projectId: 'proj_test',
  environmentId: 'env_test',
  serviceId: 'svc_test',
});

let provider: RailwayProvider;

beforeEach(() => {
  provider = new RailwayProvider({ token: 'rw_test' });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function gqlResponse(data: unknown): Response {
  return jsonResponse({ data });
}

function gqlErrorResponse(messages: string[]): Response {
  return jsonResponse({ errors: messages.map((m) => ({ message: m })) });
}

function stubFetch(...responses: Response[]): ReturnType<typeof vi.fn> {
  const queue = [...responses];
  const fn = vi.fn(async () => queue.shift() ?? jsonResponse({}, { status: 500 }));
  vi.stubGlobal('fetch', fn);
  return fn;
}

describe('RailwayProvider — conformance', () => {
  it('triggerDeploy returns a well-shaped DeployHandle', async () => {
    stubFetch(gqlResponse({ deploymentTriggerCreate: { id: 'dep_abc' } }));
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
      { backend: 'QUEUED', expectedKind: 'queued' },
      { backend: 'WAITING', expectedKind: 'queued' },
      { backend: 'INITIALIZING', expectedKind: 'queued' },
      { backend: 'SLEEPING', expectedKind: 'queued' },
      { backend: 'BUILDING', expectedKind: 'in_progress' },
      { backend: 'DEPLOYING', expectedKind: 'in_progress' },
      { backend: 'SUCCESS', expectedKind: 'success' },
      { backend: 'FAILED', expectedKind: 'failed' },
      { backend: 'CRASHED', expectedKind: 'failed' },
      { backend: 'REMOVED', expectedKind: 'cancelled' },
      { backend: 'SKIPPED', expectedKind: 'cancelled' },
    ];
    for (const c of cases) {
      stubFetch(
        gqlResponse({
          deployment: {
            status: c.backend,
            staticUrl: 'https://test.up.railway.app',
            finishedAt: '2026-05-10T00:00:00Z',
          },
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

  it('getStatus returns "queued" when the deployment is null', async () => {
    stubFetch(gqlResponse({ deployment: null }));
    const s = await provider.getStatus({
      externalRunId: 'dep_unknown',
      targetId: target.id,
      correlationId: 'c',
    });
    expect(s.kind).toBe('queued');
  });

  it('awaitCompletion returns success when the first poll already shows the deploy SUCCESS', async () => {
    stubFetch(
      gqlResponse({
        deployment: {
          status: 'SUCCESS',
          staticUrl: 'https://test.up.railway.app',
          finishedAt: '2026-05-10T00:00:00Z',
        },
      }),
    );
    const result = await provider.awaitCompletion(
      { externalRunId: 'dep_abc', targetId: target.id, correlationId: 'c' },
      30_000,
      new AbortController().signal,
    );
    expectValidResult(result);
    expect(result.status.kind).toBe('success');
    expect(result.url).toBe('https://test.up.railway.app');
  });

  it('awaitCompletion bounds total runtime by timeoutMs', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => gqlResponse({ deployment: { status: 'BUILDING' } })),
    );
    const start = Date.now();
    const result = await provider.awaitCompletion(
      { externalRunId: 'dep_abc', targetId: target.id, correlationId: 'c' },
      200,
      new AbortController().signal,
    );
    expect(Date.now() - start).toBeLessThan(2_000);
    expectValidResult(result);
    expect(result.status.kind).toBe('failed');
  });

  it('resolveUrlForRef returns null when no deploy matches the ref', async () => {
    stubFetch(gqlResponse({ deployments: { edges: [] } }));
    const url = await provider.resolveUrlForRef(target, 'unknown-sha');
    expect(url).toBeNull();
  });

  it('resolveUrlForRef returns the staticUrl when a deploy matches by sha', async () => {
    stubFetch(
      gqlResponse({
        deployments: {
          edges: [
            {
              node: {
                meta: { commitSha: 'sha-match' },
                staticUrl: 'https://hello.up.railway.app',
                status: 'SUCCESS',
              },
            },
          ],
        },
      }),
    );
    const url = await provider.resolveUrlForRef(target, 'sha-match');
    expect(url).toBe('https://hello.up.railway.app');
  });

  it('fetchLogs maps deploymentLogs entries to LogChunks', async () => {
    stubFetch(
      gqlResponse({
        deploymentLogs: [
          { timestamp: '2026-05-10T00:00:00Z', message: 'building' },
          { timestamp: '2026-05-10T00:00:01Z', message: 'deploying' },
        ],
      }),
    );
    const logs = await provider.fetchLogs(
      { externalRunId: 'dep_abc', targetId: target.id, correlationId: 'c' },
      { tailLines: 200 },
    );
    expect(Array.isArray(logs)).toBe(true);
    expect(logs.length).toBe(2);
    expect(logs[0]?.line).toBe('building');
  });

  it('rollbackProduction redeploys the matching past deployment', async () => {
    stubFetch(
      gqlResponse({
        deployments: {
          edges: [
            { node: { id: 'dep_old', meta: { commitSha: 'old-sha' } } },
          ],
        },
      }),
      gqlResponse({ deploymentRedeploy: { id: 'dep_old_redeploy' } }),
    );
    const handle = await provider.rollbackProduction(target, 'old-sha');
    expect(handle.externalRunId).toBe('dep_old_redeploy');
    expect(handle.targetId).toBe(target.id);
    expect(typeof handle.correlationId).toBe('string');
  });

  it('rollbackProduction throws when no deployment matches the sha', async () => {
    stubFetch(gqlResponse({ deployments: { edges: [] } }));
    await expect(provider.rollbackProduction(target, 'no-such-sha')).rejects.toThrow(
      /no deployment with sha/,
    );
  });

  it('throws on a GraphQL errors response', async () => {
    stubFetch(gqlErrorResponse(['unauthorized']));
    await expect(
      provider.triggerDeploy(target, { ref: 'sha', branch: 'main', correlationId: 'c' }),
    ).rejects.toThrow(/railway: unauthorized/);
  });

  it('throws on a non-2xx HTTP response', async () => {
    stubFetch(new Response('boom', { status: 500 }));
    await expect(
      provider.triggerDeploy(target, { ref: 'sha', branch: 'main', correlationId: 'c' }),
    ).rejects.toThrow(/railway 500/);
  });
});

describe('RailwayProvider — surface', () => {
  it('exposes id "railway"', () => {
    expect(provider.id).toBe('railway');
  });
});
