import picomatch from 'picomatch';
import { z } from 'zod';

/**
 * Per-project blast-radius limits (#285). Hard caps the runner applies
 * after the agent produces a diff but BEFORE the push step. Three knobs:
 *
 *   - maxFilesChanged: integer cap on distinct paths in the diff
 *   - maxLinesChanged: integer cap on additions+deletions across the diff
 *   - deniedPaths:     OR-list of globs; any matching path blocks the run
 *

 * Picomatch is used for the glob syntax — same semantics as
 * AutoPromoteRule.pathPatterns. `dot: true` so dotfiles like `.env`
 * match without forcing the operator to write a `dot/.env` prefix.
 *
 * Returns `{ ok: true }` for a passing changeset or a structured
 * breakdown of every limit that fired. The runner records the breakdown
 * on the changeset's `blockedReason` field for the UI to render verbatim.
 */
export const BlastRadiusLimits = z.object({
  maxFilesChanged: z.number().int().positive(),
  maxLinesChanged: z.number().int().positive(),
  deniedPaths: z.array(z.string().min(1)),
});
export type BlastRadiusLimits = z.infer<typeof BlastRadiusLimits>;

export interface BlastRadiusInput {
  files: { path: string; additions: number; deletions: number }[];
}

export interface DeniedHit {
  path: string;
  glob: string;
}

export type BlastRadiusResult =
  | { ok: true; filesChanged: number; linesChanged: number }
  | {
      ok: false;
      filesChanged: number;
      linesChanged: number;
      maxFilesChanged: number;
      maxLinesChanged: number;
      filesOverLimit: boolean;
      linesOverLimit: boolean;
      deniedHits: DeniedHit[];
    };

export function checkBlastRadius(
  input: BlastRadiusInput,
  limits: BlastRadiusLimits,
): BlastRadiusResult {
  const filesChanged = input.files.length;
  const linesChanged = input.files.reduce((sum, f) => sum + f.additions + f.deletions, 0);

  const filesOverLimit = filesChanged > limits.maxFilesChanged;
  const linesOverLimit = linesChanged > limits.maxLinesChanged;

  const deniedHits: DeniedHit[] = [];
  if (limits.deniedPaths.length > 0) {
    // Per-glob matchers so we can attribute the hit to the specific
    // pattern that caught the path — operators need that to tune the
    // list rather than playing whack-a-mole.
    const matchers = limits.deniedPaths.map((glob) => ({
      glob,
      match: picomatch(glob, { dot: true }),
    }));
    for (const f of input.files) {
      for (const m of matchers) {
        if (m.match(f.path)) {
          deniedHits.push({ path: f.path, glob: m.glob });
          break; // one hit per file is enough to block
        }
      }
    }
  }

  if (!filesOverLimit && !linesOverLimit && deniedHits.length === 0) {
    return { ok: true, filesChanged, linesChanged };
  }

  return {
    ok: false,
    filesChanged,
    linesChanged,
    maxFilesChanged: limits.maxFilesChanged,
    maxLinesChanged: limits.maxLinesChanged,
    filesOverLimit,
    linesOverLimit,
    deniedHits,
  };
}
