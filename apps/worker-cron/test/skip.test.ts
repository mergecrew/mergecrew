import { describe, it, expect } from 'vitest';
import { dateInTz, isSkipped } from '../src/skip.js';

describe('dateInTz', () => {
  it('formats UTC as YYYY-MM-DD', () => {
    expect(dateInTz(new Date('2026-12-25T15:30:00Z'), 'UTC')).toBe('2026-12-25');
  });

  it('respects positive offsets that bump into the next day', () => {
    // 2026-12-25T22:00Z is 2026-12-26T07:00 in Asia/Tokyo (+09:00).
    expect(dateInTz(new Date('2026-12-25T22:00:00Z'), 'Asia/Tokyo')).toBe('2026-12-26');
  });

  it('respects negative offsets that drop back to the previous day', () => {
    // 2026-12-25T02:00Z is 2026-12-24T18:00 in America/Los_Angeles (-08:00).
    expect(dateInTz(new Date('2026-12-25T02:00:00Z'), 'America/Los_Angeles')).toBe('2026-12-24');
  });
});

describe('isSkipped', () => {
  const skip = ['2026-12-25', '2027-01-01'];

  it('returns true when today (in tz) is in the list', () => {
    expect(isSkipped(skip, 'UTC', new Date('2026-12-25T08:00:00Z'))).toBe(true);
  });

  it('returns false when today is not in the list', () => {
    expect(isSkipped(skip, 'UTC', new Date('2026-12-26T08:00:00Z'))).toBe(false);
  });

  it('returns false when the list is empty', () => {
    expect(isSkipped([], 'UTC', new Date('2026-12-25T08:00:00Z'))).toBe(false);
  });

  it('compares against tz-local date, not UTC', () => {
    // Same instant resolves to a different local date in two zones.
    const t = new Date('2026-12-25T02:00:00Z');
    expect(isSkipped(['2026-12-25'], 'UTC', t)).toBe(true);
    expect(isSkipped(['2026-12-25'], 'America/Los_Angeles', t)).toBe(false);
    expect(isSkipped(['2026-12-24'], 'America/Los_Angeles', t)).toBe(true);
  });
});
