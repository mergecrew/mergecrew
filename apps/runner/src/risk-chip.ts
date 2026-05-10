import type { PullRequestFile } from '@mergecrew/adapters-vcs';

export type RiskLevel = 'low' | 'medium' | 'high';

interface TestSummaryShape {
  passed?: number;
  failed?: number;
}

/**
 * Heuristic risk score for a Changeset (V0 of #193).
 *
 * Three buckets — `low`, `medium`, `high` — chosen to match the existing
 * \`RiskChip\` zod enum and the chip styling already in the digest UI.
 * Signals (in order of weight):
 *
 * 1. **Sensitive paths.** Any file under auth, billing/payments, DB
 *    migrations, IaC, GitHub workflows, or the lifecycle config →
 *    immediately `high`. These are the paths a human reviewer almost
 *    always wants to look at.
 * 2. **Test failures.** \`testSummary.failed > 0\` → at least `medium`,
 *    upgraded to `high` only if the diff is also non-trivial. Pure red
 *    on a one-line tweak is plausibly a flaky test, not a structural
 *    risk.
 * 3. **Diff size.** Total LOC changed + file count. Big enough →
 *    `medium`. Very big → `high`.
 *
 * The heuristic is intentionally simple. If reviewers want more nuance
 * (lockfile churn, dependency adds, codeowners-tagged paths, etc.), it
 * lives as a follow-up — V0 is "make the chip non-null and useful".
 */
const SENSITIVE_PATH_PATTERNS: ReadonlyArray<RegExp> = [
  /(^|\/)auth\//i,
  /(^|\/)authentication\//i,
  /(^|\/)oauth\//i,
  /(^|\/)session\//i,
  /(^|\/)billing\//i,
  /(^|\/)payments?\//i,
  /(^|\/)payment\b/i,
  /(^|\/)stripe\//i,
  /(^|\/)migrations?\//i,
  /\.sql$/i,
  /(^|\/)terraform\//i,
  /\.tf$/i,
  /(^|\/)iac\//i,
  /(^|\/)cloudformation\//i,
  /\.cfn\.(?:json|ya?ml)$/i,
  /\.github\/workflows\//i,
  /(^|\/)mergecrew\.ya?ml$/i,
  /(^|\/)role[-_]?guard/i,
  /(^|\/)permission/i,
];

const LARGE_DIFF_LINES = 500;
const LARGE_DIFF_FILES = 20;
const MEDIUM_DIFF_LINES = 100;
const MEDIUM_DIFF_FILES = 5;

export function computeRiskChip(
  files: PullRequestFile[],
  testSummary: unknown,
): RiskLevel {
  if (touchesSensitivePath(files)) return 'high';

  const ts = (testSummary ?? {}) as TestSummaryShape;
  const testsFailed = (ts.failed ?? 0) > 0;
  const lines = diffLineCount(files);
  const fileCount = files.length;

  const big = lines >= LARGE_DIFF_LINES || fileCount >= LARGE_DIFF_FILES;
  const medium = lines >= MEDIUM_DIFF_LINES || fileCount >= MEDIUM_DIFF_FILES;

  if (testsFailed && (big || medium)) return 'high';
  if (testsFailed) return 'medium';
  if (big) return 'high';
  if (medium) return 'medium';
  return 'low';
}

function touchesSensitivePath(files: PullRequestFile[]): boolean {
  return files.some((f) => {
    const path = f.path ?? '';
    return SENSITIVE_PATH_PATTERNS.some((re) => re.test(path));
  });
}

function diffLineCount(files: PullRequestFile[]): number {
  let total = 0;
  for (const f of files) {
    total += (f.additions ?? 0) + (f.deletions ?? 0);
  }
  return total;
}
