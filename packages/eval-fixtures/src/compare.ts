import type { FixtureTolerances } from './types.js';

/**
 * Snapshot-style diff comparison for eval cases (#300). Compares the
 * agent's unified diff against the fixture's `expected.diff` and
 * returns a verdict + structured mismatches.
 *
 * What it actually checks:
 *
 *   1. **File set**: the agent touched the same files the expected
 *      diff touches (after normalizing the leading `a/` `b/` prefixes
 *      that unified diffs carry).
 *   2. **Required files**: every path in `requiredFiles` (or, when
 *      omitted, every file the expected diff touches) appears in the
 *      agent's diff.
 *   3. **Per-file line overlap**: among the lines the agent ADDED,
 *      at least 50% should also appear in the expected ADDS for
 *      that file, after applying tolerances.
 *
 * What it deliberately doesn't check:
 *
 *   - Exact line-for-line equivalence. Real LLMs produce non-identical
 *     diffs with the same intent; that's not a regression worth flagging.
 *   - Semantic equivalence via AST. That's V3 territory.
 *   - Hunk-header positions. The point is "did the agent do roughly
 *     the right thing", not "did the agent produce a byte-identical
 *     diff to the reference".
 */
export interface CompareOptions extends FixtureTolerances {
  /**
   * Files that MUST appear in the agent's diff. When undefined,
   * defaults to "every file the expected diff touches". Pass an empty
   * array to disable the required-files check entirely.
   */
  requiredFiles?: string[];
  /**
   * Threshold (0..1) for per-file line overlap. Default 0.5. The
   * agent's added lines (post-normalization) must intersect the
   * expected's added lines by at least this fraction to count as a
   * match.
   */
  overlapThreshold?: number;
}

export type SnapshotMismatch =
  | { kind: 'missing_required_file'; path: string }
  | { kind: 'unexpected_file'; path: string }
  | { kind: 'untouched_expected_file'; path: string }
  | { kind: 'low_overlap'; path: string; overlap: number; threshold: number };

export interface SnapshotResult {
  pass: boolean;
  mismatches: SnapshotMismatch[];
  /** Per-file overlap fraction (best-effort, for debugging). */
  perFileOverlap: Record<string, number>;
}

interface DiffByFile {
  [path: string]: { added: string[]; removed: string[] };
}

const FENCE_RE = /^```(?:diff)?$/;
const FILE_HEADER_RE = /^(?:diff --git\s+)?[+-]{3}\s+(?:[ab]\/)?(.+?)\s*$/;

/**
 * Parse a unified-diff blob into {file → added/removed lines}.
 *
 * Tolerant of:
 *   - Triple-backtick fences around the diff (LLMs love these)
 *   - `--- a/foo` / `+++ b/foo` prefixes (standard) or bare paths
 *   - `/dev/null` source/target paths (new file / deleted file)
 *   - Trailing whitespace, blank lines between hunks
 */
export function parseDiff(raw: string): DiffByFile {
  const out: DiffByFile = {};
  let currentFile: string | null = null;
  let inFence = false;
  for (const line of raw.split('\n')) {
    if (FENCE_RE.test(line.trim())) {
      inFence = !inFence;
      continue;
    }
    // Detect a `+++` or `---` header. `+++` is the post-image, which
    // is what we anchor on — falls back to `---` for deletions.
    if (line.startsWith('+++ ')) {
      const m = FILE_HEADER_RE.exec(line);
      const path = m?.[1];
      if (path && path !== '/dev/null') {
        currentFile = path;
        out[currentFile] ??= { added: [], removed: [] };
      }
      continue;
    }
    if (line.startsWith('--- ')) {
      const m = FILE_HEADER_RE.exec(line);
      const path = m?.[1];
      if (path && path !== '/dev/null' && currentFile == null) {
        currentFile = path;
        out[currentFile] ??= { added: [], removed: [] };
      }
      continue;
    }
    if (line.startsWith('diff --git')) {
      // The +++/--- pair that follows will set the file; reset for safety.
      currentFile = null;
      continue;
    }
    if (line.startsWith('@@')) continue; // hunk header
    if (currentFile == null) continue;
    if (line.startsWith('+')) {
      out[currentFile]!.added.push(line.slice(1));
    } else if (line.startsWith('-')) {
      out[currentFile]!.removed.push(line.slice(1));
    }
    // Context lines (start with space or nothing) — ignored.
  }
  return out;
}

function normalize(line: string, tolerances: FixtureTolerances): string {
  let s = line;
  if (tolerances.ignoreWhitespaceOnly) {
    s = s.replace(/\s+/g, ' ').trim();
  }
  if (tolerances.ignoreLocalRenames) {
    // Cheap rename tolerance: replace identifier-shaped runs with a
    // placeholder so `foo` and `bar` collapse together. Keeps keywords,
    // strings, punctuation distinguishable. Not AST-aware — a literal
    // `Foo` that happens to be a class name would also collapse, which
    // is the limitation we accept for V2.ab.
    s = s.replace(/\b[A-Za-z_][A-Za-z0-9_]*\b/g, 'IDENT');
  }
  return s;
}

function overlap(
  actual: string[],
  expected: string[],
  tolerances: FixtureTolerances,
): number {
  if (expected.length === 0) return 1;
  const normExpected = new Set(expected.map((l) => normalize(l, tolerances)).filter(Boolean));
  if (normExpected.size === 0) return 1;
  const normActual = actual.map((l) => normalize(l, tolerances)).filter(Boolean);
  let hits = 0;
  for (const l of normActual) {
    if (normExpected.has(l)) hits++;
  }
  return hits / normExpected.size;
}

export function compareSnapshot(
  agentDiff: string,
  expectedDiff: string,
  options: CompareOptions,
): SnapshotResult {
  const tolerances: FixtureTolerances = {
    ignoreLocalRenames: options.ignoreLocalRenames,
    ignoreWhitespaceOnly: options.ignoreWhitespaceOnly,
  };
  const threshold = options.overlapThreshold ?? 0.5;

  const actual = parseDiff(agentDiff);
  const expected = parseDiff(expectedDiff);

  const expectedFiles = Object.keys(expected);
  const actualFiles = Object.keys(actual);
  const requiredFiles =
    options.requiredFiles !== undefined ? options.requiredFiles : expectedFiles;

  const mismatches: SnapshotMismatch[] = [];
  const perFileOverlap: Record<string, number> = {};

  for (const path of requiredFiles) {
    if (!actualFiles.includes(path)) {
      mismatches.push({ kind: 'missing_required_file', path });
    }
  }

  for (const path of expectedFiles) {
    if (!actualFiles.includes(path)) {
      if (!mismatches.some((m) => m.kind === 'missing_required_file' && m.path === path)) {
        mismatches.push({ kind: 'untouched_expected_file', path });
      }
      continue;
    }
    const o = overlap(actual[path]!.added, expected[path]!.added, tolerances);
    perFileOverlap[path] = o;
    if (o < threshold) {
      mismatches.push({ kind: 'low_overlap', path, overlap: o, threshold });
    }
  }

  for (const path of actualFiles) {
    if (!expectedFiles.includes(path)) {
      mismatches.push({ kind: 'unexpected_file', path });
    }
  }

  return {
    pass: mismatches.length === 0,
    mismatches,
    perFileOverlap,
  };
}
