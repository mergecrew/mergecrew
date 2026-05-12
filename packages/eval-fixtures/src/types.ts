/**
 * Eval fixture manifest (#298, extended in #337).
 *
 * Two kinds, distinguished by `kind`:
 *
 *   - 'end-to-end' (default; V1 behavior): run the full agent loop
 *     against a synthetic project, score the resulting diff against
 *     `expected.diff`.
 *   - 'agent' (V2.ad): exercise a SINGLE agent in isolation. Used to
 *     attribute regressions to the right agent rather than to "the
 *     loop did something weird." Three sub-shapes, one per agent
 *     kind — see fields below.
 *
 * Existing end-to-end fixtures don't need a `kind:` field; the loader
 * defaults it. New fixtures should be explicit.
 */
export type FixtureKind = 'end-to-end' | 'agent';

export type AgentKind = 'planner' | 'coder' | 'reviewer';

export interface FixtureManifest {
  /** Stable id — matches the directory name. */
  id: string;
  /** One-line summary surfaced in CLI + dashboard. */
  description: string;
  /**
   * Fixture kind. Defaults to 'end-to-end' on YAML omission so the
   * V1 fixture corpus doesn't need rewriting.
   */
  kind: FixtureKind;
  /**
   * Which agent the fixture exercises. Required when kind='agent';
   * undefined for end-to-end (the whole loop runs).
   *   - 'planner':  expectedFiles is what the plan MUST list under
   *                 "Files to touch".
   *   - 'coder':    planMarkdown is fed in as input; the diff the
   *                 coder produces is scored via the existing snapshot
   *                 comparison against expected.diff.
   *   - 'reviewer': planMarkdown + diffMarkdown are fed as inputs;
   *                 the verdict is scored against expectedVerdict.
   */
  agentKind?: AgentKind;
  /** The agent's input prompt. Multiline allowed. */
  intent: string;
  /** Free-form language tag (typescript, python, go, markdown, …). */
  language: string;
  /** Free-form runtime tag (node, python3, go1.22, none). */
  runtime: string;
  /** Files the agent's diff (or plan) MUST mention. Empty = no constraint. */
  expectedFiles: string[];
  /** Snapshot-comparison tolerances applied in #300. */
  tolerances: FixtureTolerances;
  /**
   * Pre-baked planner plan, used by agent='coder' fixtures. The
   * harness feeds this to the coder instead of running the planner —
   * isolating the coder's behavior. Null for non-coder fixtures.
   */
  planMarkdown?: string;
  /**
   * Pre-baked diff, used by agent='reviewer' fixtures. Fed to the
   * reviewer alongside planMarkdown so the reviewer's verdict can be
   * scored without running the coder. Null for non-reviewer fixtures.
   */
  diffMarkdown?: string;
  /** Expected verdict for agent='reviewer' fixtures. */
  expectedVerdict?: 'approve' | 'request_changes';
  /** Optional free-form authoring notes (skipped by the runner). */
  notes?: string;
}

export interface FixtureTolerances {
  /** Diffs that only rename locals pass. */
  ignoreLocalRenames: boolean;
  /** Pure-whitespace diffs pass. */
  ignoreWhitespaceOnly: boolean;
}

export interface LoadedFixture {
  manifest: FixtureManifest;
  /** Absolute path to the extracted source tree. */
  workspacePath: string;
  /** Absolute path to the expected.diff file shipped with the fixture. */
  expectedDiffPath: string;
}
