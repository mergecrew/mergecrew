/**
 * Public types for the Project Inception detector (V1.1, #7).
 *
 * Inception is a one-time analysis pass over a freshly-cloned workspace.
 * It produces a structured summary of what was found (frameworks, scripts,
 * CI workflows) plus a draft `mergecrew.yaml` the user can review during
 * onboarding.
 */

export type FrameworkKind =
  | 'nextjs'
  | 'react'
  | 'nestjs'
  | 'express'
  | 'fastify'
  | 'vite'
  | 'astro'
  | 'remix'
  | 'svelte'
  | 'vue'
  | 'prisma'
  | 'drizzle'
  | 'typescript'
  | 'docker'
  | 'pnpm-workspace'
  | 'turbo';

export interface DetectedFramework {
  kind: FrameworkKind;
  /** Human-readable label, e.g. "Next.js 16". */
  label: string;
  /** Version string when discoverable from package.json or a config file. */
  version?: string;
  /** Path (relative to workspace) of the file the detection fired on. */
  evidence: string;
}

export type ScriptKind = 'build' | 'test' | 'lint' | 'typecheck' | 'dev' | 'unknown';

export interface DetectedScript {
  /** package.json script name. */
  name: string;
  /** Raw command. */
  cmd: string;
  /** Best-guess classification — used to populate the QA agent's commands. */
  kind: ScriptKind;
  /** Path of the package.json the script came from (for monorepos). */
  source: string;
}

export interface DetectedWorkflow {
  /** Path relative to workspace, e.g. ".github/workflows/deploy-dev.yml". */
  path: string;
  /** Trigger events listed in `on:` (push, workflow_dispatch, …). */
  events: string[];
  /** Whether the filename / events suggest this is a deploy workflow. */
  isDeployCandidate: boolean;
  /** Whether the workflow declares `mergecrew_correlation_id` as an input. */
  acceptsCorrelationId: boolean;
}

export interface InceptionSummary {
  frameworks: DetectedFramework[];
  scripts: DetectedScript[];
  workflows: DetectedWorkflow[];
}

export interface InceptionResult {
  summary: InceptionSummary;
  draftYaml: string;
}
