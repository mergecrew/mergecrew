/**
 * Demo project lifecycle shipped with the bundled seed (#361, V2.af).
 *
 * Lives in its own module (rather than inline in `seed.ts`) so the
 * lifecycle YAML + parsed JSON can be unit-tested for validity
 * without pulling in the seed script's `PrismaClient` side effect.
 *
 * Wired by `packages/db/src/seed.ts` for fresh demo boots. The
 * lifecycle defines Planner / Coder / Reviewer agents that the
 * orchestrator's careful-profile dispatch (#348) maps onto
 * CAREFUL_GRAPH. Operator-overrideable via the Lifecycle page.
 */

export const DEMO_CAREFUL_LIFECYCLE_PARSED = {
  version: 1,
  lifecycle: {
    workflows: [
      { id: 'multi-agent', agents: ['planner', 'coder', 'reviewer'], out: [], transitions: [] },
    ],
  },
  agents: {
    planner: {
      kind: 'Planner',
      description: 'Reads the repo + intent and emits a structured markdown plan.',
      fallback: [],
      skills: ['repo.read_file', 'repo.list_paths', 'repo.search'],
      do_not_touch: [],
      maxStepsPerRun: 8,
      maxToolCallsPerStep: 12,
    },
    coder: {
      kind: 'Coder',
      description: "Implements the planner's plan as a diff. Has read + write + git commit + tests.",
      fallback: [],
      skills: [
        'repo.read_file',
        'repo.write_file',
        'repo.list_paths',
        'repo.search',
        'repo.git.commit',
        'build.run_unit_tests',
        'build.run_typecheck',
      ],
      do_not_touch: [],
      maxStepsPerRun: 16,
      maxToolCallsPerStep: 20,
    },
    reviewer: {
      kind: 'Reviewer',
      description: "Decides approve / request_changes on the coder's diff against the plan.",
      fallback: [],
      skills: ['repo.read_file', 'repo.list_paths', 'repo.search'],
      do_not_touch: [],
      maxStepsPerRun: 4,
      maxToolCallsPerStep: 8,
    },
  },
  skills: {},
} as const;

export const DEMO_CAREFUL_LIFECYCLE_YAML = `version: 1
lifecycle:
  workflows:
    - id: multi-agent
      agents: [planner, coder, reviewer]
      out: []
agents:
  planner:
    kind: Planner
    description: Reads the repo + intent and emits a structured markdown plan.
    skills: [repo.read_file, repo.list_paths, repo.search]
    maxStepsPerRun: 8
    maxToolCallsPerStep: 12
  coder:
    kind: Coder
    description: Implements the planner's plan as a diff. Has read + write + git commit + tests.
    skills:
      - repo.read_file
      - repo.write_file
      - repo.list_paths
      - repo.search
      - repo.git.commit
      - build.run_unit_tests
      - build.run_typecheck
    maxStepsPerRun: 16
    maxToolCallsPerStep: 20
  reviewer:
    kind: Reviewer
    description: Decides approve / request_changes on the coder's diff against the plan.
    skills: [repo.read_file, repo.list_paths, repo.search]
    maxStepsPerRun: 4
    maxToolCallsPerStep: 8
skills: {}
`;
