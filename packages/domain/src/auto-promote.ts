import picomatch from 'picomatch';
import { z } from 'zod';

/**
 * Rule that decides whether a changeset can be auto-promoted (merged
 * without human review). Rules compose: every constraint that's set must
 * pass for `autoPromoteMatches` to return `matched: true`.
 *
 * Path semantics: `pathPatterns` is an OR list of globs. A changeset
 * passes the path filter when EVERY changed file matches AT LEAST ONE
 * pattern. A `name` of `'docs-only'` plus `pathPatterns: ['**\/*.md']`
 * gives the canonical "docs-only" rule.
 */
export const AutoPromoteRule = z.object({
  name: z.string().min(1).max(80),
  pathPatterns: z.array(z.string().min(1)).min(1),
  /** Reject if more than this many files changed. */
  maxFilesChanged: z.number().int().positive().optional(),
  /** Reject if (additions + deletions) exceeds this. */
  maxLinesChanged: z.number().int().positive().optional(),
  /** When true, every changed file must match `**\/*.md` or `**\/*.mdx`. */
  requireDocsOnly: z.boolean().optional(),
  /**
   * When true, the changeset must touch ONLY `package.json` / lockfiles,
   * AND any version field changes must be patch-level (semver Z bump).
   * Implementation matches "x.y.z" → "x.y.(z+n)" with no major/minor change.
   */
  requirePackageJsonPatchOnly: z.boolean().optional(),
});
export type AutoPromoteRule = z.infer<typeof AutoPromoteRule>;

export interface ChangesetFile {
  path: string;
  additions: number;
  deletions: number;
}

export interface PackageJsonVersionChange {
  /** Dependency name. */
  name: string;
  before: string;
  after: string;
}

export interface AutoPromoteCandidate {
  files: ChangesetFile[];
  /** Optional precomputed dep-version diff for `requirePackageJsonPatchOnly` rules. */
  packageJsonChanges?: PackageJsonVersionChange[];
}

export interface AutoPromoteResult {
  matched: boolean;
  reason?: string;
}

const DOC_PATTERN = picomatch(['**/*.md', '**/*.mdx'], { dot: false });
const PACKAGE_PATTERN = picomatch(
  ['**/package.json', '**/pnpm-lock.yaml', '**/package-lock.json', '**/yarn.lock'],
  { dot: false },
);

const SEMVER = /^([0-9]+)\.([0-9]+)\.([0-9]+)/;

function isPatchBump(before: string, after: string): boolean {
  const a = SEMVER.exec(before.replace(/^[\^~]/, ''));
  const b = SEMVER.exec(after.replace(/^[\^~]/, ''));
  if (!a || !b) return false;
  if (a[1] !== b[1]) return false;
  if (a[2] !== b[2]) return false;
  // Patch must increase strictly (downgrades and equals don't qualify).
  return Number(b[3]) > Number(a[3]);
}

/**
 * Test a candidate changeset against a rule. Returns `{ matched: true }`
 * if every constraint passes; otherwise `{ matched: false, reason }` with
 * a human-readable explanation suitable for an audit-log entry.
 */
export function autoPromoteMatches(
  rule: AutoPromoteRule,
  changeset: AutoPromoteCandidate,
): AutoPromoteResult {
  if (changeset.files.length === 0) {
    return { matched: false, reason: 'no files changed' };
  }

  if (rule.maxFilesChanged !== undefined && changeset.files.length > rule.maxFilesChanged) {
    return {
      matched: false,
      reason: `${changeset.files.length} files changed (limit ${rule.maxFilesChanged})`,
    };
  }

  if (rule.maxLinesChanged !== undefined) {
    const total = changeset.files.reduce((acc, f) => acc + f.additions + f.deletions, 0);
    if (total > rule.maxLinesChanged) {
      return {
        matched: false,
        reason: `${total} lines changed (limit ${rule.maxLinesChanged})`,
      };
    }
  }

  const matchPath = picomatch(rule.pathPatterns, { dot: false });
  for (const f of changeset.files) {
    if (!matchPath(f.path)) {
      return {
        matched: false,
        reason: `${f.path} does not match any pathPatterns`,
      };
    }
  }

  if (rule.requireDocsOnly) {
    for (const f of changeset.files) {
      if (!DOC_PATTERN(f.path)) {
        return { matched: false, reason: `${f.path} is not a docs file` };
      }
    }
  }

  if (rule.requirePackageJsonPatchOnly) {
    for (const f of changeset.files) {
      if (!PACKAGE_PATTERN(f.path)) {
        return {
          matched: false,
          reason: `${f.path} is not a package manifest`,
        };
      }
    }
    // Safety: rejecting when the caller didn't supply parsed version
    // diffs prevents a path-pattern-only check from auto-promoting a
    // package.json that has e.g. a major bump. The caller MUST parse
    // and pass `packageJsonChanges` to use this rule flag.
    if (changeset.packageJsonChanges === undefined) {
      return {
        matched: false,
        reason: 'requirePackageJsonPatchOnly requires parsed packageJsonChanges',
      };
    }
    for (const c of changeset.packageJsonChanges) {
      if (!isPatchBump(c.before, c.after)) {
        return {
          matched: false,
          reason: `${c.name}: ${c.before} → ${c.after} is not a patch bump`,
        };
      }
    }
  }

  return { matched: true };
}
