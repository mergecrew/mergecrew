import { describe, expect, it } from 'vitest';
import { computeRiskChip } from '../src/risk-chip.js';
import type { PullRequestFile } from '@mergecrew/adapters-vcs';

function file(
  partial: Partial<PullRequestFile> & { path: string },
): PullRequestFile {
  return {
    oldPath: null,
    status: 'modified',
    additions: 0,
    deletions: 0,
    hunks: [],
    ...partial,
  };
}

describe('computeRiskChip', () => {
  it('returns "low" for a small clean diff with passing tests', () => {
    const files = [file({ path: 'src/utils/format.ts', additions: 8, deletions: 2 })];
    const summary = { passed: 12, failed: 0 };
    expect(computeRiskChip(files, summary)).toBe('low');
  });

  it('returns "low" when no test summary is available and the diff is tiny', () => {
    const files = [file({ path: 'README.md', additions: 1, deletions: 1 })];
    expect(computeRiskChip(files, null)).toBe('low');
    expect(computeRiskChip(files, {})).toBe('low');
  });

  it('returns "medium" on a moderate diff', () => {
    const files = [
      file({ path: 'src/api/users.ts', additions: 60, deletions: 20 }),
      file({ path: 'src/api/projects.ts', additions: 40, deletions: 10 }),
    ];
    expect(computeRiskChip(files, { passed: 25, failed: 0 })).toBe('medium');
  });

  it('returns "medium" when more than 5 files are touched, even if line count is small', () => {
    const files = Array.from({ length: 6 }, (_, i) =>
      file({ path: `src/components/Btn${i}.tsx`, additions: 2, deletions: 1 }),
    );
    expect(computeRiskChip(files, { passed: 3, failed: 0 })).toBe('medium');
  });

  it('returns "high" on a very large diff', () => {
    const files = Array.from({ length: 25 }, (_, i) =>
      file({ path: `src/lib/foo${i}.ts`, additions: 30, deletions: 10 }),
    );
    expect(computeRiskChip(files, { passed: 100, failed: 0 })).toBe('high');
  });

  it('returns "high" when a sensitive auth path is touched, regardless of diff size', () => {
    const files = [file({ path: 'apps/api/src/auth/jwt.ts', additions: 3, deletions: 0 })];
    expect(computeRiskChip(files, { passed: 1, failed: 0 })).toBe('high');
  });

  it('returns "high" when a billing/payment path is touched', () => {
    const files = [file({ path: 'apps/api/src/billing/payment-method.ts', additions: 4, deletions: 1 })];
    expect(computeRiskChip(files, null)).toBe('high');
  });

  it('returns "high" when a database migration is touched', () => {
    const files = [
      file({ path: 'packages/db/prisma/migrations/20260601_x/migration.sql', additions: 12, deletions: 0 }),
    ];
    expect(computeRiskChip(files, null)).toBe('high');
  });

  it('returns "high" when GitHub Actions workflows are touched', () => {
    const files = [file({ path: '.github/workflows/ci.yml', additions: 5, deletions: 1 })];
    expect(computeRiskChip(files, { passed: 0, failed: 0 })).toBe('high');
  });

  it('returns "medium" on test failure with a small diff (likely flake)', () => {
    const files = [file({ path: 'src/utils/format.ts', additions: 3, deletions: 1 })];
    expect(computeRiskChip(files, { passed: 5, failed: 2 })).toBe('medium');
  });

  it('returns "high" on test failure with a non-trivial diff', () => {
    const files = [
      file({ path: 'src/api/users.ts', additions: 80, deletions: 30 }),
      file({ path: 'src/api/projects.ts', additions: 50, deletions: 20 }),
    ];
    expect(computeRiskChip(files, { passed: 10, failed: 3 })).toBe('high');
  });
});
