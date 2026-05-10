import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import type { TimelineEvent } from '@mergecrew/domain';
import { Eventlog } from '../src/eventlog.js';
import { RedisPubSub } from '../src/pubsub.js';

vi.mock('@mergecrew/db', () => ({
  withTenant: async (_org: string, fn: any) =>
    fn({
      timelineEvent: {
        create: vi.fn(async () => ({})),
      },
    }),
}));

const fakeRedis: any = {
  publish: vi.fn(async () => 0),
  duplicate: () => fakeRedis,
  subscribe: vi.fn(async () => {}),
  unsubscribe: vi.fn(async () => {}),
  on: vi.fn(),
  quit: vi.fn(async () => {}),
};

describe('Eventlog fanout hook (#148)', () => {
  let pubsub: RedisPubSub;

  beforeEach(() => {
    vi.clearAllMocks();
    pubsub = new RedisPubSub(() => fakeRedis);
  });

  afterEach(async () => {
    await pubsub.close();
  });

  it('invokes the fanout callback exactly once per emit', async () => {
    const fanout = vi.fn(async (_e: TimelineEvent) => {});
    const log = new Eventlog(pubsub, fanout);
    await log.emit({
      organizationId: 'org-1',
      projectId: 'proj-1',
      type: 'RUN_COMPLETED' as any,
      actor: { kind: 'system' },
    });
    expect(fanout).toHaveBeenCalledOnce();
    const arg = fanout.mock.calls[0]![0];
    expect(arg.type).toBe('RUN_COMPLETED');
    expect(arg.organizationId).toBe('org-1');
    expect(arg.projectId).toBe('proj-1');
    expect(arg.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('still emits when the fanout hook throws (best-effort)', async () => {
    const fanout = vi.fn(async () => {
      throw new Error('queue down');
    });
    const log = new Eventlog(pubsub, fanout);
    await expect(
      log.emit({
        organizationId: 'org-1',
        projectId: 'proj-1',
        type: 'RUN_COMPLETED' as any,
        actor: { kind: 'system' },
      }),
    ).resolves.toBeDefined();
    expect(fanout).toHaveBeenCalledOnce();
  });

  it('skips fanout when no hook is provided (back-compat)', async () => {
    const log = new Eventlog(pubsub);
    await expect(
      log.emit({
        organizationId: 'org-1',
        projectId: 'proj-1',
        type: 'RUN_COMPLETED' as any,
        actor: { kind: 'system' },
      }),
    ).resolves.toBeDefined();
    // No assertion needed — just confirming no throw.
  });
});
