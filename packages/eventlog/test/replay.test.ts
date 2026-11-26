import { describe, expect, it, vi, beforeEach } from 'vitest';
import { Eventlog } from '../src/eventlog.js';
import type { RedisPubSub } from '../src/pubsub.js';

const findFirst = vi.fn();
const findMany = vi.fn();

vi.mock('@mergecrew/db', () => ({
  withTenant: async (_org: string, fn: any) =>
    fn({ timelineEvent: { findFirst, findMany } }),
}));

describe('Eventlog.replayRun tenant scoping', () => {
  beforeEach(() => {
    findFirst.mockReset();
    findMany.mockReset();
    findMany.mockResolvedValue([]);
  });

  it('scopes the replay query by organizationId and run id, not RLS alone', async () => {
    const log = new Eventlog({} as RedisPubSub);
    await log.replayRun('org-a', 'run-b');
    expect(findMany).toHaveBeenCalledTimes(1);
    expect(findMany.mock.calls[0]![0].where).toEqual({ organizationId: 'org-a', dailyRunId: 'run-b' });
  });

  it('resolves the Last-Event-ID marker only within the same org and run', async () => {
    findFirst.mockResolvedValue({ id: 42n });
    const log = new Eventlog({} as RedisPubSub);
    await log.replayRun('org-a', 'run-a', 'evt-1');
    expect(findFirst.mock.calls[0]![0].where).toEqual({
      eventId: 'evt-1',
      organizationId: 'org-a',
      dailyRunId: 'run-a',
    });
    expect(findMany.mock.calls[0]![0].where).toEqual({
      organizationId: 'org-a',
      dailyRunId: 'run-a',
      id: { gt: 42n },
    });
  });
});
