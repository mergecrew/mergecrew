/**
 * Conformance test for the Fly.io deploy adapter (#199).
 *
 * Fly is image-based rather than git-ref-based, so the contract has
 * one nuance: \`opts.ref\` MUST carry a SHA so the adapter can derive
 * the image tag (\`registry.fly.io/<app>:<sha>\` by default). Beyond
 * that, the contract assertions from \`./conformance.ts\` apply
 * unchanged.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FlyProvider } from '../src/fly.js';
import {
  expectValidHandle,
  expectValidResult,
  expectValidStatus,
  jsonResponse,
  makeTarget,
} from './conformance.js';

const target = makeTarget('fly', { appName: 'acme-web' });
let provider: FlyProvider;

beforeEach(() => {
  provider = new FlyProvider({ token: 'fly_test' });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubFetch(...responses: Response[]): ReturnType<typeof vi.fn> {
  const queue = [...responses];
  const fn = vi.fn(async () => queue.shift() ?? jsonResponse({}, { status: 500 }));
  vi.stubGlobal('fetch', fn);
  return fn;
}

describe('FlyProvider — conformance (trigger)', () => {
  it('triggerDeploy returns a well-shaped DeployHandle, with the SHA as externalRunId', async () => {
    stubFetch(
      // 1. listMachines
      jsonResponse([
        { id: 'm1', config: { image: 'registry.fly.io/acme-web:older', env: { X: '1' } }, state: 'started' },
        { id: 'm2', config: { image: 'registry.fly.io/acme-web:older', env: { X: '1' } }, state: 'started' },
      ]),
      // 2-3. update each machine
      jsonResponse({}),
      jsonResponse({}),
    );
    const handle = await provider.triggerDeploy(target, {
      ref: 'sha123',
      branch: 'main',
      correlationId: 'corr-1',
    });
    expectValidHandle(handle, { targetId: target.id, correlationId: 'corr-1' });
    expect(handle.externalRunId).toBe('sha123');
  });

  it('triggerDeploy throws when opts.ref is empty (image tag would be ambiguous)', async () => {
    await expect(
      provider.triggerDeploy(target, { ref: '', branch: 'main', correlationId: 'c' }),
    ).rejects.toThrow(/opts\.ref must carry a SHA/);
  });

  it('triggerDeploy throws when the app has no machines yet', async () => {
    stubFetch(jsonResponse([]));
    await expect(
      provider.triggerDeploy(target, { ref: 'sha', branch: 'main', correlationId: 'c' }),
    ).rejects.toThrow(/has no machines/);
  });

  it('triggerDeploy substitutes {sha} into a custom imageTemplate', async () => {
    const customTarget = makeTarget('fly', {
      appName: 'acme-web',
      imageTemplate: 'ghcr.io/acme/web:{sha}',
    });
    const fetchMock = stubFetch(
      jsonResponse([{ id: 'm1', config: { image: 'old' }, state: 'started' }]),
      jsonResponse({}),
    );
    await provider.triggerDeploy(customTarget, {
      ref: 'sha-abc',
      branch: 'main',
      correlationId: 'c',
    });
    const updateBody = JSON.parse(fetchMock.mock.calls[1]?.[1]?.body as string);
    expect(updateBody.config.image).toBe('ghcr.io/acme/web:sha-abc');
  });
});

describe('FlyProvider — conformance (status)', () => {
  beforeEach(() => {
    FlyProvider.rememberRoute('sha123', { appName: 'acme-web' });
  });

  it('getStatus returns success when every machine is started and on the target image', async () => {
    stubFetch(
      jsonResponse([
        { id: 'm1', config: { image: 'registry.fly.io/acme-web:sha123' }, state: 'started' },
        { id: 'm2', config: { image: 'registry.fly.io/acme-web:sha123' }, state: 'started' },
      ]),
    );
    const s = await provider.getStatus({
      externalRunId: 'sha123',
      targetId: target.id,
      correlationId: 'c',
    });
    expectValidStatus(s);
    expect(s.kind).toBe('success');
    if (s.kind === 'success') expect(s.url).toBe('https://acme-web.fly.dev');
  });

  it('getStatus returns in_progress while a machine is still on the old image', async () => {
    stubFetch(
      jsonResponse([
        { id: 'm1', config: { image: 'registry.fly.io/acme-web:sha123' }, state: 'started' },
        { id: 'm2', config: { image: 'registry.fly.io/acme-web:older' }, state: 'starting' },
      ]),
    );
    const s = await provider.getStatus({
      externalRunId: 'sha123',
      targetId: target.id,
      correlationId: 'c',
    });
    expect(s.kind).toBe('in_progress');
  });

  it('getStatus returns failed when a machine is on the target image but failed/destroyed', async () => {
    stubFetch(
      jsonResponse([
        { id: 'm1', config: { image: 'registry.fly.io/acme-web:sha123' }, state: 'failed' },
      ]),
    );
    const s = await provider.getStatus({
      externalRunId: 'sha123',
      targetId: target.id,
      correlationId: 'c',
    });
    expectValidStatus(s);
    expect(s.kind).toBe('failed');
  });

  it('getStatus returns queued when the handle has no registered route', async () => {
    const s = await provider.getStatus({
      externalRunId: 'never-registered',
      targetId: target.id,
      correlationId: 'c',
    });
    expect(s.kind).toBe('queued');
  });

  it('getStatus uses publicUrl override when configured', async () => {
    FlyProvider.rememberRoute('sha-custom', {
      appName: 'acme-web',
      publicUrl: 'https://app.example.com',
    });
    stubFetch(
      jsonResponse([
        { id: 'm1', config: { image: 'registry.fly.io/acme-web:sha-custom' }, state: 'started' },
      ]),
    );
    const s = await provider.getStatus({
      externalRunId: 'sha-custom',
      targetId: target.id,
      correlationId: 'c',
    });
    expect(s.kind).toBe('success');
    if (s.kind === 'success') expect(s.url).toBe('https://app.example.com');
  });
});

describe('FlyProvider — conformance (await + URL + logs + rollback)', () => {
  beforeEach(() => {
    FlyProvider.rememberRoute('sha-await', { appName: 'acme-web' });
    FlyProvider.rememberRoute('sha-rollback', { appName: 'acme-web' });
  });

  it('awaitCompletion returns success when first poll already shows all machines on target', async () => {
    stubFetch(
      jsonResponse([
        { id: 'm1', config: { image: 'registry.fly.io/acme-web:sha-await' }, state: 'started' },
      ]),
    );
    const result = await provider.awaitCompletion(
      { externalRunId: 'sha-await', targetId: target.id, correlationId: 'c' },
      30_000,
      new AbortController().signal,
    );
    expectValidResult(result);
    expect(result.status.kind).toBe('success');
  });

  it('awaitCompletion bounds total runtime by timeoutMs', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse([
          { id: 'm1', config: { image: 'old' }, state: 'starting' },
        ]),
      ),
    );
    const start = Date.now();
    const result = await provider.awaitCompletion(
      { externalRunId: 'sha-await', targetId: target.id, correlationId: 'c' },
      200,
      new AbortController().signal,
    );
    expect(Date.now() - start).toBeLessThan(2_000);
    expectValidResult(result);
    expect(result.status.kind).toBe('failed');
  });

  it('resolveUrlForRef returns the default fly.dev URL', async () => {
    const url = await provider.resolveUrlForRef(target, 'any-sha');
    expect(url).toBe('https://acme-web.fly.dev');
  });

  it('resolveUrlForRef returns publicUrl when configured', async () => {
    const customTarget = makeTarget('fly', {
      appName: 'acme-web',
      publicUrl: 'https://app.example.com',
    });
    const url = await provider.resolveUrlForRef(customTarget, 'sha');
    expect(url).toBe('https://app.example.com');
  });

  it('fetchLogs returns an array (empty by adapter contract)', async () => {
    const logs = await provider.fetchLogs(
      { externalRunId: 'sha', targetId: target.id, correlationId: 'c' },
      { tailLines: 100 },
    );
    expect(Array.isArray(logs)).toBe(true);
  });

  it('rollbackProduction triggers a deploy at the rollback SHA', async () => {
    stubFetch(
      jsonResponse([{ id: 'm1', config: { image: 'old' }, state: 'started' }]),
      jsonResponse({}),
    );
    const handle = await provider.rollbackProduction(target, 'sha-rollback');
    expect(handle.externalRunId).toBe('sha-rollback');
    expect(handle.targetId).toBe(target.id);
  });

  it('throws on a non-2xx HTTP response', async () => {
    stubFetch(new Response('boom', { status: 500 }));
    await expect(
      provider.triggerDeploy(target, { ref: 'sha', branch: 'main', correlationId: 'c' }),
    ).rejects.toThrow(/fly 500/);
  });
});

describe('FlyProvider — surface', () => {
  it('exposes id "fly"', () => {
    expect(provider.id).toBe('fly');
  });
});
