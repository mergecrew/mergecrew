import picomatch from 'picomatch';

/**
 * Risk score for a changeset (#286). A simple weighted sum:
 *
 *   score = filesChanged + linesChanged * 0.1 + sensitivePathHits * 10
 *
 * Picked to be inspectable rather than clever: the breakdown is the
 * point. Operators reading the inbox card need to be able to nod and
 * say "yes, that should need my eyes" without reverse-engineering a
 * neural net.
 *
 *   - filesChanged contributes 1 per file → 25 files = 25 points
 *   - linesChanged contributes 0.1 per net-edited line → 500 LOC = 50
 *     points (big diffs without sensitive paths still cross the
 *     default threshold of 50)
 *   - sensitivePathHits multiplied by 10 so a single touch to a
 *     flagged path nudges a small diff toward review
 *
 * The threshold lives on the project (`autoMergeThreshold`). A score
 * STRICTLY GREATER than the threshold trips the gate; setting threshold
 * to Infinity is the cheap way to disable.
 */
export interface RiskScoreInput {
  files: { path: string; additions: number; deletions: number }[];
}

export interface RiskScoreSensitiveHit {
  path: string;
  glob: string;
}

export interface RiskScoreBreakdown {
  filesChanged: number;
  linesChanged: number;
  sensitiveHits: RiskScoreSensitiveHit[];
  score: number;
}

export function computeRiskScore(
  input: RiskScoreInput,
  sensitivePaths: string[],
): RiskScoreBreakdown {
  const filesChanged = input.files.length;
  const linesChanged = input.files.reduce((sum, f) => sum + f.additions + f.deletions, 0);

  const sensitiveHits: RiskScoreSensitiveHit[] = [];
  if (sensitivePaths.length > 0) {
    const matchers = sensitivePaths.map((glob) => ({
      glob,
      match: picomatch(glob, { dot: true }),
    }));
    for (const f of input.files) {
      for (const m of matchers) {
        if (m.match(f.path)) {
          sensitiveHits.push({ path: f.path, glob: m.glob });
          break; // one hit per file
        }
      }
    }
  }

  const score = filesChanged + linesChanged * 0.1 + sensitiveHits.length * 10;
  return { filesChanged, linesChanged, sensitiveHits, score };
}
