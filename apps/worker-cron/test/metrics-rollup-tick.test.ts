import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  metricsRollupTick,
  _resetMetricsRollupTickState,
} from '../src/metrics-rollup-tick.js';
import { truncToHour, truncToDay } from '@mergecrew/db';

const computeMock = vi.fn();

// Stub @mergecrew/db so the tick is pure unit territory — no DB roundtrip,
// just the bucket-selection + dedup logic the tick adds on top of the
// helper.
vi.mock('@mergecrew/db', async () => {
  return {
    truncToHour: (d: Date) => {
      const t = new Date(d.getTime());
      t.setUTCMinutes(0, 0, 0);
      return t;
    },
    truncToDay: (d: Date) => {
      const t = new Date(d.getTime());
      t.setUTCHours(0, 0, 0, 0);
      return t;
    },
    computeMetricsRollups: (opts: unknown) => {
      computeMock(opts);
      return Promise.resolve({
        bucketStart: (opts as { bucketStart: Date }).bucketStart,
        bucketEnd: new Date(0),
        granularity: (opts as { granularity: 'hour' | 'day' }).granularity,
        orgRows: 0,
        projectRows: 0,
      });
    },
  };
});

const logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
} as unknown as Parameters<typeof metricsRollupTick>[0]['logger'];

describe('metricsRollupTick', () => {
  beforeEach(() => {
    computeMock.mockClear();
    _resetMetricsRollupTickState();
  });

  it('targets the previous fully-elapsed hour bucket', async () => {
    const now = new Date('2026-05-22T14:32:11Z');
    await metricsRollupTick({ logger, now });

    const hourly = computeMock.mock.calls.find(
      (c) => c[0].granularity === 'hour',
    );
    expect(hourly).toBeDefined();
    expect((hourly![0].bucketStart as Date).toISOString()).toBe(
      '2026-05-22T13:00:00.000Z',
    );
  });

  it('targets the previous calendar UTC day for the daily bucket', async () => {
    const now = new Date('2026-05-22T00:45:00Z');
    await metricsRollupTick({ logger, now });

    const daily = computeMock.mock.calls.find(
      (c) => c[0].granularity === 'day',
    );
    expect(daily).toBeDefined();
    expect((daily![0].bucketStart as Date).toISOString()).toBe(
      '2026-05-21T00:00:00.000Z',
    );
  });

  it('skips re-running the same hourly bucket within the same process', async () => {
    const now = new Date('2026-05-22T14:32:11Z');
    await metricsRollupTick({ logger, now });
    await metricsRollupTick({
      logger,
      now: new Date('2026-05-22T14:58:50Z'),
    });

    const hourly = computeMock.mock.calls.filter(
      (c) => c[0].granularity === 'hour',
    );
    expect(hourly).toHaveLength(1);
  });

  it('re-runs the hourly bucket once the next hour closes', async () => {
    await metricsRollupTick({
      logger,
      now: new Date('2026-05-22T14:32:00Z'),
    });
    await metricsRollupTick({
      logger,
      now: new Date('2026-05-22T15:05:00Z'),
    });

    const hourly = computeMock.mock.calls.filter(
      (c) => c[0].granularity === 'hour',
    );
    expect(hourly).toHaveLength(2);
    expect((hourly[0]![0].bucketStart as Date).toISOString()).toBe(
      '2026-05-22T13:00:00.000Z',
    );
    expect((hourly[1]![0].bucketStart as Date).toISOString()).toBe(
      '2026-05-22T14:00:00.000Z',
    );
  });

  it('survives a thrown error in the helper without crashing', async () => {
    computeMock.mockImplementationOnce(() => {
      throw new Error('boom');
    });
    await expect(
      metricsRollupTick({
        logger,
        now: new Date('2026-05-22T14:32:00Z'),
      }),
    ).resolves.toBeUndefined();
  });
});

describe('truncToHour / truncToDay re-export', () => {
  it('truncToHour zeros minutes/seconds/ms (UTC)', () => {
    const out = truncToHour(new Date('2026-05-22T14:32:11.500Z'));
    expect(out.toISOString()).toBe('2026-05-22T14:00:00.000Z');
  });

  it('truncToDay zeros hours/minutes/seconds/ms (UTC)', () => {
    const out = truncToDay(new Date('2026-05-22T14:32:11.500Z'));
    expect(out.toISOString()).toBe('2026-05-22T00:00:00.000Z');
  });
});
