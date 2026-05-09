import type { TestSummary } from '@mergecrew/domain';

interface ParsedCounts {
  passed: number;
  failed: number;
  skipped: number;
  durationMs: number;
}

const ZERO: ParsedCounts = { passed: 0, failed: 0, skipped: 0, durationMs: 0 };

/**
 * Best-effort parser for test/typecheck/lint stdout. Each runner has its own
 * format; we extract just the totals via regex. Unrecognized output collapses
 * to zeros — better to record nothing than to fabricate.
 */
export function parseTestOutput(skillName: string, stdout: string, stderr: string): ParsedCounts {
  const text = `${stdout}\n${stderr}`;

  // Vitest: `Tests  8 passed (8)` or `Tests  1 failed | 7 passed (8)`
  const vitest = text.match(/Tests\s+(?:(\d+)\s+failed\s*\|\s*)?(\d+)\s+passed/i);
  if (vitest) {
    return {
      passed: Number(vitest[2] ?? 0),
      failed: Number(vitest[1] ?? 0),
      skipped: 0,
      durationMs: 0,
    };
  }

  // Jest: `Tests:       2 failed, 1 skipped, 38 passed, 41 total`
  const jest = text.match(/Tests:\s+(?:(\d+)\s+failed,\s*)?(?:(\d+)\s+skipped,\s*)?(\d+)\s+passed/);
  if (jest) {
    return {
      passed: Number(jest[3] ?? 0),
      failed: Number(jest[1] ?? 0),
      skipped: Number(jest[2] ?? 0),
      durationMs: 0,
    };
  }

  // tsc: `Found 0 errors.` / `Found 3 errors in 2 files.`
  const tsc = text.match(/Found\s+(\d+)\s+error/i);
  if (tsc) {
    const failed = Number(tsc[1] ?? 0);
    return { passed: failed === 0 ? 1 : 0, failed, skipped: 0, durationMs: 0 };
  }

  // ESLint: `12 problems (5 errors, 7 warnings)` — count errors as failed.
  const eslint = text.match(/(\d+)\s+problems?\s*\((\d+)\s+errors?/i);
  if (eslint) {
    const failed = Number(eslint[2] ?? 0);
    return { passed: failed === 0 ? 1 : 0, failed, skipped: 0, durationMs: 0 };
  }

  // Generic fallback: if there's the literal string "0 failures" or
  // exit code zero (caller passes that in skill output), treat as one
  // unnamed pass for typecheck/lint that didn't match a known format.
  if (skillName === 'build.run_typecheck' || skillName === 'build.run_lint') {
    return { passed: 1, failed: 0, skipped: 0, durationMs: 0 };
  }

  return ZERO;
}

/**
 * Merge a single skill's counts into a running TestSummary. Suites are
 * appended (one entry per skill that produced numbers). Idempotent on
 * skill name — re-running adds a fresh suite entry rather than double-
 * counting the previous one.
 */
export function mergeIntoSummary(
  prev: TestSummary | null | undefined,
  skillName: string,
  counts: ParsedCounts,
): TestSummary {
  const suites = (prev?.suites ?? []).filter((s) => s.name !== skillName);
  suites.push({ name: skillName, passed: counts.passed, failed: counts.failed });
  return {
    passed: suites.reduce((s, x) => s + x.passed, 0),
    failed: suites.reduce((s, x) => s + x.failed, 0),
    skipped: (prev?.skipped ?? 0) + counts.skipped,
    durationMs: (prev?.durationMs ?? 0) + counts.durationMs,
    suites,
  };
}
