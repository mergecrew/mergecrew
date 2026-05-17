import { describe, expect, it } from 'vitest';
import { effectiveBaseBranch } from '../src/connected-repo.js';

describe('effectiveBaseBranch', () => {
  it('returns defaultBranch when basePrBranch is null', () => {
    expect(
      effectiveBaseBranch({ defaultBranch: 'main', basePrBranch: null }),
    ).toBe('main');
  });

  it('returns defaultBranch when basePrBranch is undefined', () => {
    expect(effectiveBaseBranch({ defaultBranch: 'main' })).toBe('main');
  });

  it('returns basePrBranch when set', () => {
    expect(
      effectiveBaseBranch({ defaultBranch: 'main', basePrBranch: 'developer' }),
    ).toBe('developer');
  });

  it('coalesces whitespace-only basePrBranch to defaultBranch', () => {
    expect(
      effectiveBaseBranch({ defaultBranch: 'main', basePrBranch: '   ' }),
    ).toBe('main');
  });

  it('coalesces empty-string basePrBranch to defaultBranch', () => {
    expect(
      effectiveBaseBranch({ defaultBranch: 'main', basePrBranch: '' }),
    ).toBe('main');
  });
});
