import { describe, expect, it } from 'vitest';
import { interpolateTagPattern } from '../src/tag-pattern.js';

describe('interpolateTagPattern', () => {
  const fixedDate = new Date('2026-05-17T03:00:00.000Z');

  it('interpolates ${YYYY-MM-DD} from the supplied date', () => {
    expect(interpolateTagPattern('release-${YYYY-MM-DD}', 'abcdef1234567890', fixedDate)).toBe(
      'release-2026-05-17',
    );
  });

  it('interpolates ${shortSha} to the first 7 chars of the SHA', () => {
    expect(interpolateTagPattern('v-${shortSha}', 'abcdef1234567890', fixedDate)).toBe(
      'v-abcdef1',
    );
  });

  it('interpolates both placeholders in one pattern', () => {
    expect(
      interpolateTagPattern('v${YYYY-MM-DD}-${shortSha}', 'abcdef1234567890', fixedDate),
    ).toBe('v2026-05-17-abcdef1');
  });

  it('leaves unknown placeholders as literals', () => {
    // Misspelled placeholders surface in the tag name so the user
    // sees the bug rather than mergecrew silently producing a bad tag.
    expect(interpolateTagPattern('v-${ShortSha}', 'abcdef1234567890', fixedDate)).toBe(
      'v-${ShortSha}',
    );
  });

  it('handles patterns with no placeholders', () => {
    expect(interpolateTagPattern('latest', 'abcdef1234567890', fixedDate)).toBe('latest');
  });

  it('replaces every occurrence of a placeholder', () => {
    expect(
      interpolateTagPattern('${YYYY-MM-DD}-x-${YYYY-MM-DD}', 'abcdef1', fixedDate),
    ).toBe('2026-05-17-x-2026-05-17');
  });

  it('handles SHAs shorter than 7 chars without crashing', () => {
    expect(interpolateTagPattern('v-${shortSha}', 'abc', fixedDate)).toBe('v-abc');
  });
});
