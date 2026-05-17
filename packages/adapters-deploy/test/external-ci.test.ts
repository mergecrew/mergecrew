/**
 * Conformance test for the external-ci deploy adapter (#467).
 *
 * Unlike vendor-backed adapters, external-ci makes no outbound HTTP
 * calls — it's a passthrough that records the preview URL the user's
 * existing CI/CD pipeline publishes to. The tests verify the contract
 * still holds (well-shaped handles, valid statuses) and that URL
 * resolution honors `urlPattern` interpolation.
 */

import { describe, expect, it } from 'vitest';
import { ExternalCiProvider } from '../src/external-ci.js';
import {
  expectValidHandle,
  expectValidResult,
  expectValidStatus,
  makeTarget,
} from './conformance.js';

const provider = new ExternalCiProvider();

describe('ExternalCiProvider — conformance', () => {
  it('exposes id "external-ci"', () => {
    expect(provider.id).toBe('external-ci');
  });

  it('triggerDeploy returns a well-shaped DeployHandle without any HTTP', async () => {
    const target = makeTarget('external-ci', { urlFixed: 'https://dev.example.com' });
    const handle = await provider.triggerDeploy(target, {
      ref: 'sha123',
      branch: 'main',
      correlationId: 'corr-1',
    });
    expectValidHandle(handle, { targetId: target.id, correlationId: 'corr-1' });
  });

  it('getStatus reports success immediately', async () => {
    const s = await provider.getStatus({
      externalRunId: 'external-ci-c',
      targetId: 'target-test',
      correlationId: 'c',
    });
    expectValidStatus(s);
    expect(s.kind).toBe('success');
  });

  it('awaitCompletion resolves immediately with success', async () => {
    const result = await provider.awaitCompletion(
      { externalRunId: 'external-ci-c', targetId: 'target-test', correlationId: 'c' },
      30_000,
      new AbortController().signal,
    );
    expectValidResult(result);
    expect(result.status.kind).toBe('success');
  });

  it('resolveUrlForRef returns the fixed URL when only urlFixed is set', async () => {
    const target = makeTarget('external-ci', { urlFixed: 'https://dev.example.com' });
    const url = await provider.resolveUrlForRef(target, 'sha123');
    expect(url).toBe('https://dev.example.com');
  });

  it('resolveUrlForRef interpolates ${branch} and ${sha} when urlPattern is set', async () => {
    const target = makeTarget('external-ci', {
      urlPattern: 'https://${branch}.preview.example.com/${sha}',
    });
    const url = await provider.resolveUrlForRef(target, 'abc1234');
    // resolveUrlForRef only carries ref, not branch — branch interpolates to ''.
    expect(url).toBe('https://.preview.example.com/abc1234');
  });

  it('resolveUrlForRef returns null when no URL is configured', async () => {
    const target = makeTarget('external-ci', {});
    const url = await provider.resolveUrlForRef(target, 'sha');
    expect(url).toBeNull();
  });

  it('fetchLogs returns an empty array', async () => {
    const logs = await provider.fetchLogs(
      { externalRunId: 'external-ci-c', targetId: 'target-test', correlationId: 'c' },
      { tailLines: 100 },
    );
    expect(logs).toEqual([]);
  });

  it('rollbackProduction returns a well-shaped DeployHandle', async () => {
    const target = makeTarget('external-ci', { urlFixed: 'https://prod.example.com' });
    const handle = await provider.rollbackProduction(target, 'old-sha');
    expect(handle.targetId).toBe(target.id);
    expect(typeof handle.externalRunId).toBe('string');
    expect(typeof handle.correlationId).toBe('string');
  });
});
