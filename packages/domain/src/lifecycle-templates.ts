/**
 * Stock lifecycle templates (#392, V2.ai).
 *
 * One-click starting points for operators creating a new project who
 * don't want to write YAML by hand. Each template ships a complete,
 * valid `MergecrewConfig` (validated by the package test against the
 * domain schema) plus a human-readable YAML body for the Lifecycle
 * editor to populate.
 *
 * The catalog is intentionally small (#392 ships four) and centered on
 * the same Planner / Coder / Reviewer agent set the orchestrator's
 * careful profile (#336) already knows how to drive — stack-specific
 * tuning lives in the `description` copy and (eventually) skill
 * bindings as more stock skills land. Adding a stack-specific template
 * shouldn't require any orchestrator change.
 *
 * Consumers: API endpoint `GET /v1/lifecycle-templates/stock` (#393)
 * and the project Lifecycle picker (#394). Operators apply a template
 * by writing its `sourceYaml` into the project's lifecycle text and
 * (re)parsing — the structured form drops cleanly into the existing
 * lifecycle storage column.
 */
import type { z } from 'zod';
import { parse as parseYaml } from 'yaml';
import { MergecrewConfig } from './lifecycle.js';
import { DEFAULT_MERGECREW_YAML } from './default-mergecrew-yaml.js';

/**
 * Input-side type — fields with zod defaults can be omitted. Lets
 * templates stay terse without losing typecheck coverage.
 */
type MergecrewConfigInput = z.input<typeof MergecrewConfig>;

export interface StockLifecycleTemplate {
  /** URL-safe slug. Stable identifier for `?template=` deep links. */
  id: string;
  /** Short display name for the picker. */
  name: string;
  /** One-line "what it's for" shown next to the name. */
  description: string;
  /**
   * Tag chips shown on the card (e.g. `['Next.js', 'Vercel']`). Order
   * matters for layout — leading tag is the primary framework.
   */
  stack: string[];
  /** Human-editable YAML body, written to the project's lifecycle column on apply. */
  sourceYaml: string;
  /** Parsed equivalent — single source of truth the test cross-validates against the YAML. */
  parsed: MergecrewConfigInput;
}

// ---------------------------------------------------------------------------
// generic-careful
//
// The default template: same shape as the bundled demo lifecycle. Picked
// when the operator doesn't know which stack-specific template fits.
// ---------------------------------------------------------------------------

const GENERIC_CAREFUL_PARSED: MergecrewConfigInput = {
  version: 1,
  lifecycle: {
    workflows: [
      { id: 'multi-agent', agents: ['planner', 'coder', 'reviewer'] },
    ],
  },
  agents: {
    planner: {
      kind: 'Planner',
      description: 'Reads the repo + intent and emits a structured markdown plan.',
      skills: ['repo.read_file', 'repo.list_paths', 'repo.search'],
      maxStepsPerRun: 8,
      maxToolCallsPerStep: 12,
    },
    coder: {
      kind: 'Coder',
      description: "Implements the planner's plan as a diff. Has read + write + git commit + tests.",
      skills: [
        'repo.read_file',
        'repo.write_file',
        'repo.list_paths',
        'repo.search',
        'repo.git.commit',
        'build.run_unit_tests',
        'build.run_typecheck',
      ],
      maxStepsPerRun: 16,
      maxToolCallsPerStep: 20,
    },
    reviewer: {
      kind: 'Reviewer',
      description: "Decides approve / request_changes on the coder's diff against the plan.",
      skills: ['repo.read_file', 'repo.list_paths', 'repo.search'],
      maxStepsPerRun: 4,
      maxToolCallsPerStep: 8,
    },
  },
};

const GENERIC_CAREFUL_YAML = `version: 1
lifecycle:
  workflows:
    - id: multi-agent
      agents: [planner, coder, reviewer]
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
`;

// ---------------------------------------------------------------------------
// nextjs-vercel
//
// Tuned for Next.js / TypeScript repos that deploy via Vercel. Same
// skill set (the stock skills are stack-agnostic), but the agent copy
// names Next.js-flavored expectations the planner will be making — e.g.
// app-router conventions, `app/` vs `pages/`, server actions. The
// reviewer is asked to look for TS error regressions and unused server
// imports, which Next.js builds catch.
// ---------------------------------------------------------------------------

const NEXTJS_VERCEL_PARSED: MergecrewConfigInput = {
  version: 1,
  lifecycle: {
    workflows: [
      { id: 'multi-agent', agents: ['planner', 'coder', 'reviewer'] },
    ],
  },
  agents: {
    planner: {
      kind: 'Planner',
      description:
        'Plans Next.js app-router changes: identifies the right route segment, server vs client components, and which `app/`/`pages/` paths to touch.',
      skills: ['repo.read_file', 'repo.list_paths', 'repo.search'],
      maxStepsPerRun: 8,
      maxToolCallsPerStep: 12,
    },
    coder: {
      kind: 'Coder',
      description:
        "Implements the plan as a Next.js diff. Runs typecheck after edits — Next.js's build fails hard on stray TS errors, so catching them early shortens the reviewer loop.",
      skills: [
        'repo.read_file',
        'repo.write_file',
        'repo.list_paths',
        'repo.search',
        'repo.git.commit',
        'build.run_unit_tests',
        'build.run_typecheck',
      ],
      maxStepsPerRun: 16,
      maxToolCallsPerStep: 20,
    },
    reviewer: {
      kind: 'Reviewer',
      description:
        "Reviews the coder's diff: TS soundness, server/client boundary correctness, and that the route segment still matches the plan's stated layout.",
      skills: ['repo.read_file', 'repo.list_paths', 'repo.search'],
      maxStepsPerRun: 4,
      maxToolCallsPerStep: 8,
    },
  },
};

const NEXTJS_VERCEL_YAML = `version: 1
lifecycle:
  workflows:
    - id: multi-agent
      agents: [planner, coder, reviewer]
agents:
  planner:
    kind: Planner
    description: >-
      Plans Next.js app-router changes: identifies the right route segment, server vs client
      components, and which \`app/\`/\`pages/\` paths to touch.
    skills: [repo.read_file, repo.list_paths, repo.search]
    maxStepsPerRun: 8
    maxToolCallsPerStep: 12
  coder:
    kind: Coder
    description: >-
      Implements the plan as a Next.js diff. Runs typecheck after edits — Next.js's build
      fails hard on stray TS errors, so catching them early shortens the reviewer loop.
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
    description: >-
      Reviews the coder's diff: TS soundness, server/client boundary correctness, and that
      the route segment still matches the plan's stated layout.
    skills: [repo.read_file, repo.list_paths, repo.search]
    maxStepsPerRun: 4
    maxToolCallsPerStep: 8
`;

// ---------------------------------------------------------------------------
// python-render
//
// Python services (FastAPI / Flask / Django) deploying on Render. The
// coder is reminded to keep `requirements.txt` / `pyproject.toml` in
// sync with imports — a common pitfall when the model hallucinates a
// new dep but forgets to add it to the manifest.
// ---------------------------------------------------------------------------

const PYTHON_RENDER_PARSED: MergecrewConfigInput = {
  version: 1,
  lifecycle: {
    workflows: [
      { id: 'multi-agent', agents: ['planner', 'coder', 'reviewer'] },
    ],
  },
  agents: {
    planner: {
      kind: 'Planner',
      description:
        'Plans Python service changes: identifies modules to touch, lists existing tests that exercise the area, and flags any new external deps.',
      skills: ['repo.read_file', 'repo.list_paths', 'repo.search'],
      maxStepsPerRun: 8,
      maxToolCallsPerStep: 12,
    },
    coder: {
      kind: 'Coder',
      description:
        "Implements the plan. Keeps `requirements.txt` / `pyproject.toml` in sync with new imports — Render's build will fail at install time if a dep is missing.",
      skills: [
        'repo.read_file',
        'repo.write_file',
        'repo.list_paths',
        'repo.search',
        'repo.git.commit',
        'build.run_unit_tests',
        'build.run_typecheck',
      ],
      maxStepsPerRun: 16,
      maxToolCallsPerStep: 20,
    },
    reviewer: {
      kind: 'Reviewer',
      description:
        "Reviews the coder's diff: import / manifest agreement, that new tests cover the change, and that public function signatures didn't shift without callers updating.",
      skills: ['repo.read_file', 'repo.list_paths', 'repo.search'],
      maxStepsPerRun: 4,
      maxToolCallsPerStep: 8,
    },
  },
};

const PYTHON_RENDER_YAML = `version: 1
lifecycle:
  workflows:
    - id: multi-agent
      agents: [planner, coder, reviewer]
agents:
  planner:
    kind: Planner
    description: >-
      Plans Python service changes: identifies modules to touch, lists existing tests that
      exercise the area, and flags any new external deps.
    skills: [repo.read_file, repo.list_paths, repo.search]
    maxStepsPerRun: 8
    maxToolCallsPerStep: 12
  coder:
    kind: Coder
    description: >-
      Implements the plan. Keeps \`requirements.txt\` / \`pyproject.toml\` in sync with new
      imports — Render's build will fail at install time if a dep is missing.
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
    description: >-
      Reviews the coder's diff: import / manifest agreement, that new tests cover the change,
      and that public function signatures didn't shift without callers updating.
    skills: [repo.read_file, repo.list_paths, repo.search]
    maxStepsPerRun: 4
    maxToolCallsPerStep: 8
`;

// ---------------------------------------------------------------------------
// go-fly
//
// Go services on Fly.io. The reviewer leans on `go vet` / build
// correctness (delivered through the generic typecheck skill) and the
// coder is reminded that Go's compile-time strictness catches a lot of
// what other stacks defer to tests.
// ---------------------------------------------------------------------------

const GO_FLY_PARSED: MergecrewConfigInput = {
  version: 1,
  lifecycle: {
    workflows: [
      { id: 'multi-agent', agents: ['planner', 'coder', 'reviewer'] },
    ],
  },
  agents: {
    planner: {
      kind: 'Planner',
      description:
        'Plans Go service changes: identifies packages to touch, public interfaces affected, and which tests cover the area.',
      skills: ['repo.read_file', 'repo.list_paths', 'repo.search'],
      maxStepsPerRun: 8,
      maxToolCallsPerStep: 12,
    },
    coder: {
      kind: 'Coder',
      description:
        "Implements the plan. Runs build/test after edits — Go's compiler catches most boundary issues, so a passing typecheck means the diff is close to correct.",
      skills: [
        'repo.read_file',
        'repo.write_file',
        'repo.list_paths',
        'repo.search',
        'repo.git.commit',
        'build.run_unit_tests',
        'build.run_typecheck',
      ],
      maxStepsPerRun: 16,
      maxToolCallsPerStep: 20,
    },
    reviewer: {
      kind: 'Reviewer',
      description:
        "Reviews the coder's diff: idiomatic error handling, no shadowed variables, public API changes are intentional, and tests exercise new branches.",
      skills: ['repo.read_file', 'repo.list_paths', 'repo.search'],
      maxStepsPerRun: 4,
      maxToolCallsPerStep: 8,
    },
  },
};

const GO_FLY_YAML = `version: 1
lifecycle:
  workflows:
    - id: multi-agent
      agents: [planner, coder, reviewer]
agents:
  planner:
    kind: Planner
    description: >-
      Plans Go service changes: identifies packages to touch, public interfaces affected,
      and which tests cover the area.
    skills: [repo.read_file, repo.list_paths, repo.search]
    maxStepsPerRun: 8
    maxToolCallsPerStep: 12
  coder:
    kind: Coder
    description: >-
      Implements the plan. Runs build/test after edits — Go's compiler catches most boundary
      issues, so a passing typecheck means the diff is close to correct.
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
    description: >-
      Reviews the coder's diff: idiomatic error handling, no shadowed variables, public API
      changes are intentional, and tests exercise new branches.
    skills: [repo.read_file, repo.list_paths, repo.search]
    maxStepsPerRun: 4
    maxToolCallsPerStep: 8
`;

// ---------------------------------------------------------------------------
// roster (#515)
//
// The full 8-stage / 10-agent lifecycle Mergecrew was originally
// designed around: Discovery → PM → Implementation (BackendEngineer +
// FrontendEngineer) → QA → DeployDev (SRE) → Observation (Observation,
// DesignReviewer, BugTriage, DocWriter). Reads directly from
// `DEFAULT_MERGECREW_YAML` (`default-mergecrew-yaml.ts`) so the YAML
// stays the single source of truth — the parsed form is derived at
// module load via `MergecrewConfig.parse(parseYaml(...))`.
//
// Picked as the auto-applied default for new projects (`#480` →
// `DEFAULT_STOCK_TEMPLATE_ID` in `apps/api/src/modules/project/project.service.ts`)
// — replaces the legacy `generic-careful` 3-agent default.
// ---------------------------------------------------------------------------

const ROSTER_YAML = DEFAULT_MERGECREW_YAML;
// Parse + validate at module load. A break in `DEFAULT_MERGECREW_YAML`
// fails the import — caught by every consumer's first test run rather
// than surfacing as a runtime crash on a real run.
const ROSTER_PARSED = MergecrewConfig.parse(parseYaml(ROSTER_YAML)) as MergecrewConfigInput;

export const STOCK_LIFECYCLE_TEMPLATES: StockLifecycleTemplate[] = [
  {
    id: 'roster',
    name: 'Full roster (Discovery → PM → Implementation → QA → Deploy → Observation)',
    description:
      "The original mergecrew design: 10 specialized agents across 6 stages. Discovery surfaces what to work on; PM scopes specs; Backend + Frontend engineers implement in parallel; QA verifies; SRE deploys to dev; the observation fan-out reports back. Pick this if you want the full vision; pick a careful-flow template below for the simpler 3-agent loop.",
    stack: ['Any'],
    sourceYaml: ROSTER_YAML,
    parsed: ROSTER_PARSED,
  },
  {
    id: 'generic-careful',
    name: 'Generic (careful flow)',
    description:
      "Planner → Coder → Reviewer with reviewer loop-back. Stack-agnostic — pick this if you're not sure.",
    stack: ['Any'],
    sourceYaml: GENERIC_CAREFUL_YAML,
    parsed: GENERIC_CAREFUL_PARSED,
  },
  {
    id: 'nextjs-vercel',
    name: 'Next.js on Vercel',
    description:
      'Careful flow tuned for Next.js app-router projects. Planner thinks in route segments; reviewer enforces TS soundness.',
    stack: ['Next.js', 'TypeScript', 'Vercel'],
    sourceYaml: NEXTJS_VERCEL_YAML,
    parsed: NEXTJS_VERCEL_PARSED,
  },
  {
    id: 'python-render',
    name: 'Python service on Render',
    description:
      'Careful flow tuned for FastAPI / Flask / Django services. Coder keeps requirements in sync with imports.',
    stack: ['Python', 'FastAPI', 'Render'],
    sourceYaml: PYTHON_RENDER_YAML,
    parsed: PYTHON_RENDER_PARSED,
  },
  {
    id: 'go-fly',
    name: 'Go service on Fly.io',
    description:
      "Careful flow tuned for Go services. Leans on the compiler's strictness; reviewer focuses on idiom + API surface.",
    stack: ['Go', 'Fly.io'],
    sourceYaml: GO_FLY_YAML,
    parsed: GO_FLY_PARSED,
  },
];

export function findStockLifecycleTemplate(id: string): StockLifecycleTemplate | undefined {
  return STOCK_LIFECYCLE_TEMPLATES.find((t) => t.id === id);
}
