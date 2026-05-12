/**
 * Built-in agent definitions for the V2.ad / V2.ae multi-agent flow
 * (#347). When a project opts into `graphProfile=careful` (#336), the
 * orchestrator dispatches these three agents without requiring the
 * operator to define them in lifecycle YAML.
 *
 * The agent runtime (`@mergecrew/agent-runtime`) already enforces tool
 * filtering and prompt selection by kind (#332, #334) — these
 * definitions just give the orchestrator a concrete starting point.
 * Operators who write a Planner/Coder/Reviewer kind in their own
 * lifecycle YAML override these.
 *
 * Stock skills referenced here are all in `@mergecrew/skills/stock`.
 * The skill-existence cross-check lives in the package test so a
 * future skill rename can't silently break stock-agent boot.
 */

import type { AgentDefinition } from './lifecycle.js';

/**
 * Planner: read-only inspection of the repo and lifecycle context.
 * Output is a markdown plan; no edits, no shell, no git ops. The
 * runtime defensively filters non-read skills before bindTools, so the
 * skills list here is a request — the runtime is the wall.
 */
export const STOCK_PLANNER_AGENT: AgentDefinition = {
  kind: 'Planner',
  description:
    'Reads the repo + intent and emits a structured markdown plan listing files to touch, files to avoid, and validation steps. Read-only.',
  fallback: [],
  skills: ['repo.read_file', 'repo.list_paths', 'repo.search'],
  do_not_touch: [],
  // Plans rarely need many model turns — the agent reads a handful of
  // files, then writes the plan. 8 steps is generous; cap stops a
  // runaway exploration before it burns the planner's budget share.
  maxStepsPerRun: 8,
  maxToolCallsPerStep: 12,
  budget: {
    tokens: 50_000,
    usd: 0.5,
  },
};

/**
 * Coder: implements the planner's plan. Full edit + git surface; the
 * out-of-scope guard in the runner (#333) detects when the diff
 * touches files the plan said NOT to touch and flags the reviewer.
 *
 * Doesn't get shell exec or deploy skills — those belong to higher-up
 * agents in the project's lifecycle. The coder's job is producing the
 * diff; running it and shipping it are different agents.
 */
export const STOCK_CODER_AGENT: AgentDefinition = {
  kind: 'Coder',
  description:
    'Implements the planner\'s plan as a diff. Has read + write + git commit. Stays within the plan\'s "Files to touch" scope.',
  fallback: [],
  skills: [
    'repo.read_file',
    'repo.write_file',
    'repo.list_paths',
    'repo.search',
    'repo.git.commit',
    // Tests are part of "implementing the plan" — the planner's
    // validation step typically lists running the unit suite.
    'build.run_unit_tests',
    'build.run_typecheck',
  ],
  do_not_touch: [],
  // The coder is the workhorse. Generous step + tool budgets so it can
  // iterate: read, edit, run tests, fix, commit.
  maxStepsPerRun: 16,
  maxToolCallsPerStep: 20,
  budget: {
    tokens: 200_000,
    usd: 4.0,
  },
};

/**
 * Reviewer: gates the coder's diff before PR open. Read-only — the
 * verdict is the side effect.
 */
export const STOCK_REVIEWER_AGENT: AgentDefinition = {
  kind: 'Reviewer',
  description:
    'Decides approve / request_changes on the coder\'s diff against the plan. Read-only; verdict is the side effect.',
  fallback: [],
  skills: ['repo.read_file', 'repo.list_paths', 'repo.search'],
  do_not_touch: [],
  // The reviewer reads the plan + diff + a couple of files; rarely
  // needs to loop. Tight cap so a reviewer that's behaving badly
  // doesn't drain its budget share.
  maxStepsPerRun: 4,
  maxToolCallsPerStep: 8,
  budget: {
    tokens: 30_000,
    usd: 0.3,
  },
};

/**
 * Lookup map keyed by agent kind. The orchestrator (#348) reads this
 * when materializing a careful-profile run; the kind names are the
 * same strings the runtime branches on (PLANNER_AGENT_KIND, etc.).
 */
export const STOCK_AGENTS: Record<'Planner' | 'Coder' | 'Reviewer', AgentDefinition> = {
  Planner: STOCK_PLANNER_AGENT,
  Coder: STOCK_CODER_AGENT,
  Reviewer: STOCK_REVIEWER_AGENT,
};
