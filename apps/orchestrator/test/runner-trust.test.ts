/**
 * Built-in runner trust gate (ADR-0006): keyed on org UUID, re-checked at
 * dispatch, and backfilled `instance_builtin` rows of untrusted orgs are
 * reset at boot. Pure unit test — no Redis/Postgres needed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { downgradeUntrustedBuiltinProfiles, effectiveRunnerKind } from '../src/runner-trust.js';

const ORG_TRUSTED = '6f1c2b3a-0000-4000-8000-000000000001';
const ORG_OTHER = '6f1c2b3a-0000-4000-8000-000000000002';
const KEYS = [
  'MERGECREW_TRUSTED_ORG_IDS',
  'MERGECREW_OWNER_ORG_ID',
  'MERGECREW_TRUSTED_ORG_SLUGS',
  'MERGECREW_OWNER_ORG_SLUG',
] as const;
const saved: Partial<Record<(typeof KEYS)[number], string | undefined>> = {};

beforeEach(() => {
  for (const k of KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('effectiveRunnerKind', () => {
  it('refuses instance_builtin for an org that is not trusted now, even if the row says so', () => {
    expect(effectiveRunnerKind('instance_builtin', ORG_OTHER)).toBe('instance_builtin_untrusted');
  });

  it('ignores the legacy slug envs', () => {
    process.env.MERGECREW_OWNER_ORG_SLUG = 'acme';
    process.env.MERGECREW_TRUSTED_ORG_SLUGS = 'acme';
    expect(effectiveRunnerKind('instance_builtin', ORG_OTHER)).toBe('instance_builtin_untrusted');
  });

  it('allows instance_builtin for trusted org ids and passes other kinds through', () => {
    process.env.MERGECREW_OWNER_ORG_ID = ORG_TRUSTED;
    expect(effectiveRunnerKind('instance_builtin', ORG_TRUSTED)).toBe('instance_builtin');
    expect(effectiveRunnerKind('agent', ORG_OTHER)).toBe('agent');
    expect(effectiveRunnerKind('none', ORG_OTHER)).toBe('none');
  });
});

describe('downgradeUntrustedBuiltinProfiles', () => {
  it('resets instance_builtin rows of every org outside the id allowlist', async () => {
    process.env.MERGECREW_TRUSTED_ORG_IDS = ORG_TRUSTED;
    const updateMany = vi.fn(async () => ({ count: 3 }));
    const logger = { warn: vi.fn(), info: vi.fn() };
    const n = await downgradeUntrustedBuiltinProfiles({ runnerProfile: { updateMany } }, logger as any);
    expect(n).toBe(3);
    expect(updateMany).toHaveBeenCalledWith({
      where: { kind: 'instance_builtin', organizationId: { notIn: [ORG_TRUSTED] } },
      data: { kind: 'none' },
    });
    expect(logger.warn).toHaveBeenCalled();
  });

  it('with no trusted ids, downgrades every instance_builtin row and warns about legacy slug envs', async () => {
    process.env.MERGECREW_OWNER_ORG_SLUG = 'acme';
    const updateMany = vi.fn(async () => ({ count: 0 }));
    const logger = { warn: vi.fn(), info: vi.fn() };
    await downgradeUntrustedBuiltinProfiles({ runnerProfile: { updateMany } }, logger as any);
    expect(updateMany.mock.calls[0]![0]).toEqual({
      where: { kind: 'instance_builtin', organizationId: { notIn: [] } },
      data: { kind: 'none' },
    });
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });
});
