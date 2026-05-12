/**
 * Eval fixture manifest (#298). One YAML file per fixture sitting next
 * to the source tree under `fixtures/<id>/manifest.yaml`. The loader
 * parses + validates; downstream code (eval-runner, snapshot
 * assertions) consumes the typed object.
 */
export interface FixtureManifest {
  /** Stable id — matches the directory name. */
  id: string;
  /** One-line summary surfaced in CLI + dashboard. */
  description: string;
  /** The agent's input prompt. Multiline allowed. */
  intent: string;
  /** Free-form language tag (typescript, python, go, markdown, …). */
  language: string;
  /** Free-form runtime tag (node, python3, go1.22, none). */
  runtime: string;
  /** Files the agent's diff MUST touch. Empty array = no constraint. */
  expectedFiles: string[];
  /** Snapshot-comparison tolerances applied in #300. */
  tolerances: FixtureTolerances;
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
