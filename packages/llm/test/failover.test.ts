import { describe, it, expect, beforeEach } from 'vitest';
import { CapabilityRouter, CircuitBreaker, ProviderRegistry } from '../src/index.js';
import type { LlmProfile } from '../src/types.js';

/**
 * V1.9 #66 spec: a profile of [primary, fallback, last-resort] survives
 * a forced primary outage. The chat-level path is exercised in
 * chat.test.ts; this proves the router's resolve-on-recordOutcome path
 * — which is the actual failover mechanism — picks the next candidate
 * once the primary's circuit opens.
 */

const profile: LlmProfile = {
  id: 'p',
  name: 'p',
  preferenceOrder: ['primary/m1', 'fallback/m1', 'lastresort/m1'],
  capabilityRouting: {},
};

function makeRouter(): { router: CapabilityRouter; breaker: CircuitBreaker } {
  const registry = new ProviderRegistry([
    { id: 'primary', kind: 'anthropic', apiKey: 'x', models: ['m1'] },
    { id: 'fallback', kind: 'openai', apiKey: 'x', models: ['m1'] },
    { id: 'lastresort', kind: 'ollama', endpoint: 'http://x', models: ['m1'] },
  ]);
  const breaker = new CircuitBreaker();
  const router = new CapabilityRouter(registry, breaker);
  return { router, breaker };
}

describe('failover via CapabilityRouter + CircuitBreaker', () => {
  let router: CapabilityRouter;

  beforeEach(() => {
    router = makeRouter().router;
  });

  it('picks the first candidate from preferenceOrder when nothing is broken', () => {
    const r = router.resolve({ capability: {}, profile });
    expect(r.providerId).toBe('primary');
    expect(r.modelId).toBe('m1');
  });

  it('skips a candidate once its breaker opens (≥10 samples, ≥25% failures)', () => {
    // Drive 10 failures into primary/m1 — meets MIN_SAMPLES threshold and 100%
    // failure rate, so the breaker opens.
    for (let i = 0; i < 10; i++) router.recordOutcome('primary', 'm1', false);

    const r = router.resolve({ capability: {}, profile });
    expect(r.providerId).toBe('fallback');
  });

  it('returns to the primary after enough successes recover it', () => {
    // Simulate a transient failure window: 3 failures, 9 successes — at most
    // 3/12 = 25% failure rate, breaker stays closed.
    for (let i = 0; i < 3; i++) router.recordOutcome('primary', 'm1', false);
    for (let i = 0; i < 9; i++) router.recordOutcome('primary', 'm1', true);
    const r = router.resolve({ capability: {}, profile });
    expect(r.providerId).toBe('primary');
  });

  it('falls all the way through to the last-resort when both primary and fallback are broken', () => {
    for (let i = 0; i < 10; i++) router.recordOutcome('primary', 'm1', false);
    for (let i = 0; i < 10; i++) router.recordOutcome('fallback', 'm1', false);
    const r = router.resolve({ capability: {}, profile });
    expect(r.providerId).toBe('lastresort');
  });

  it('throws ProviderUnavailableError when every candidate is broken', () => {
    for (let i = 0; i < 10; i++) router.recordOutcome('primary', 'm1', false);
    for (let i = 0; i < 10; i++) router.recordOutcome('fallback', 'm1', false);
    for (let i = 0; i < 10; i++) router.recordOutcome('lastresort', 'm1', false);
    expect(() => router.resolve({ capability: {}, profile })).toThrow(/no provider satisfies/);
  });

  it('honors `override` over the profile preference order', () => {
    const r = router.resolve({
      capability: {},
      profile,
      override: 'fallback/m1',
    });
    expect(r.providerId).toBe('fallback');
  });

  it('skips an override that points at an unknown model', () => {
    const r = router.resolve({
      capability: {},
      profile,
      override: 'fallback/does-not-exist',
    });
    // Falls through to preferenceOrder.
    expect(r.providerId).toBe('primary');
  });
});

describe('per-agent capabilityRouting upgrade', () => {
  it('a profile entry that raises required capability narrows the candidate set', () => {
    const registry = new ProviderRegistry([
      // `cheap` claims no tool support; `tools-capable` does.
      { id: 'cheap', kind: 'openai', apiKey: 'x', models: ['m1'], capabilityOverrides: { 'm1': {} } as any },
      { id: 'tools-capable', kind: 'anthropic', apiKey: 'x', models: ['m1'] },
    ]);
    const router = new CapabilityRouter(registry, new CircuitBreaker());

    const profileWithRouting: LlmProfile = {
      id: 'p',
      name: 'p',
      preferenceOrder: ['cheap/m1', 'tools-capable/m1'],
      capabilityRouting: { 'planner': { tools: true } },
    };

    // Without per-agent routing, cheap wins (it's first).
    const noRouting = router.resolve({ capability: {}, profile: profileWithRouting });
    expect(noRouting.providerId).toBe('cheap');

    // With per-agent routing for 'planner', 'cheap' is filtered out
    // because its capability set doesn't satisfy `tools: true`.
    const withRouting = router.resolve({
      capability: {},
      profile: profileWithRouting,
      agentKind: 'planner',
    });
    expect(withRouting.providerId).toBe('tools-capable');
  });
});
