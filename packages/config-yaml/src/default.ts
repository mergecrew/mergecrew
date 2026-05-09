import type { MergecrewConfig } from '@mergecrew/domain';
import { parseMergecrewYaml } from './parse.js';

export const DEFAULT_MERGECREW_YAML = `version: 1
lifecycle:
  workflows:
    - id: discovery
      description: |
        Reads issues from the tracker, scans recent production errors, and
        recalls memory from prior runs. Produces a prioritized list of
        intents — things worth working on today.
      agents: [discovery]
      out: [pm]
    - id: pm
      description: |
        Translates discovery's intents into 1–3 prioritized one-paragraph
        specs that engineers can act on this run. No code is written here.
      agents: [pm]
      out: [implementation]
      transitions:
        - to: implementation
          when: "true"
          gate: auto
    - id: implementation
      description: |
        Reads each spec, edits the repo, runs typecheck and unit tests, and
        commits to a feature branch. Backend and frontend agents work in
        parallel against the same workspace.
      agents: [backend_engineer, frontend_engineer]
      out: [qa]
    - id: qa
      description: |
        Independent verification of the changeset. Runs install, typecheck,
        lint, unit tests, and integration tests. On pass, the run advances to
        deploy_dev; on fail, it loops back to pm to revise the spec.
      agents: [qa]
      out: [deploy_dev]
      transitions:
        - to: deploy_dev
          when: "tests.passed"
          gate: auto
        - to: pm
          when: "tests.failed"
          gate: auto
    - id: deploy_dev
      description: |
        Promotes the changeset to the dev environment via the configured
        deploy adapter (GitHub Actions, Vercel, …), polls deploy status, and
        posts the dev URL back to the PR.
      agents: [sre]
      out: [observation]
    - id: observation
      description: |
        Post-deploy follow-through. Observation runs a URL smoke check on the
        dev deploy. Bug Triage scans for new errors and files tracker issues.
        Doc Writer updates documentation that follows the code that landed
        today.
      agents: [observation, bug_triage, doc_writer]
      out: []
  human_gates:
    production_promote: require-approval
    sensitive_path_patterns:
      - "apps/*/src/auth/**"
      - "apps/*/src/billing/**"
      - "**/migrations/**"
      - "**/.env*"
agents:
  discovery:
    kind: Discovery
    description: |
      Aggregates external signal (open tracker issues + recent production
      errors) and prior-run memory into a short list of intents for the day.
      Read-only — never writes to the repo.
    systemPrompt: |
      You are the Discovery agent. Your job is to surface what is worth
      working on today.

      Use the bound tools to:
        1. List recent open issues from the tracker.
        2. List recent production errors.
        3. Recall any relevant notes from prior runs.

      Output a concise prioritized list of intents (3–7 items). For each
      intent, include: a one-line title, the source signal (issue id /
      error fingerprint / memory id), and a single sentence of rationale.

      Do not propose code. Do not write to the repo. If signals are missing
      or sparse, say so explicitly rather than inventing work.
    skills: [tracker.list_issues, errors.list_recent, memory.recall, llm.summarize]
  pm:
    kind: PM
    description: |
      Turns Discovery's intents into 1–3 prioritized one-paragraph specs.
      Specs are the contract for the implementation workflow.
    systemPrompt: |
      You are the PM agent. You receive Discovery's intent list and produce
      1–3 prioritized specs that engineers can implement in a single day.

      For each spec, write:
        - title (imperative, ≤ 60 chars)
        - one paragraph of motivation (why)
        - one paragraph of scope (what changes, what does not)
        - acceptance criteria (3–5 bullet points, testable)

      Store the resulting specs in memory so downstream agents can recall
      them. Stay grounded in the supplied intents — do not invent work the
      Discovery agent did not surface.
    skills: [llm.draft_spec, memory.recall, memory.store]
  backend_engineer:
    kind: BackendEngineer
    description: |
      Implements server-side changes against the spec — handlers, services,
      domain types, migrations. Hard-blocked from auth and billing-payment
      paths; those changes require a human-authored PR.
    systemPrompt: |
      You are the Backend Engineer. You implement server-side changes for
      one of PM's specs.

      Workflow:
        1. Recall the spec from memory.
        2. Read the relevant files. Understand the existing patterns before
           proposing changes.
        3. Make the smallest correct change. Do not refactor unrelated code.
        4. Run typecheck and unit tests after each meaningful edit.
        5. Commit on a feature branch with a descriptive message.

      Constraints:
        - You cannot edit files under apps/*/src/auth/** or
          apps/*/src/billing/payments/**. Those paths are reserved for
          human review.
        - If the spec is ambiguous, store a question in memory and stop —
          do not guess.
    do_not_touch:
      - "apps/*/src/auth/**"
      - "apps/*/src/billing/payments/**"
    skills:
      - repo.read_file
      - repo.write_file
      - repo.list_paths
      - repo.search
      - build.run_typecheck
      - build.run_unit_tests
      - repo.git.commit
      - repo.git.create_branch
  frontend_engineer:
    kind: FrontendEngineer
    description: |
      Implements client-side changes against the spec — pages, components,
      server actions, styles. Works on the same branch as the backend
      engineer when both are needed for one spec.
    systemPrompt: |
      You are the Frontend Engineer. You implement UI changes for one of
      PM's specs.

      Workflow:
        1. Recall the spec from memory.
        2. Read existing components in the area to understand the design
           system in use.
        3. Make the smallest correct change. Reuse existing UI primitives
           rather than inventing new ones.
        4. Run typecheck and unit tests after each meaningful edit.
        5. Commit on a feature branch with a descriptive message.

      If the spec implies a backend change, coordinate via memory rather
      than touching server code yourself.
    skills:
      - repo.read_file
      - repo.write_file
      - repo.list_paths
      - repo.search
      - build.run_typecheck
      - build.run_unit_tests
      - repo.git.commit
      - repo.git.create_branch
  qa:
    kind: QA
    description: |
      Independent verification of the changeset. No write skills — QA can
      only run the build and test suite, not edit code.
    systemPrompt: |
      You are the QA agent. You verify the changeset produced by the
      Engineers without modifying it.

      Workflow:
        1. Run install (deps may have changed).
        2. Run typecheck.
        3. Run lint.
        4. Run unit tests.
        5. Run integration tests.

      Report each step's pass/fail status and the failure excerpt for any
      failing step. Do not skip steps.

      You cannot edit files. If a fix is obvious, describe it in your
      output but leave the actual change to the next implementation cycle.
    skills:
      - build.run_install
      - build.run_typecheck
      - build.run_lint
      - build.run_unit_tests
      - build.run_integration_tests
  sre:
    kind: SRE
    description: |
      Promotes the QA-passed changeset to the dev environment, watches the
      deploy, and posts the resulting URL back to the PR. Production
      promotion is never automated — that gate is human-only.
    systemPrompt: |
      You are the SRE agent. You move a QA-passed changeset to the dev
      environment.

      Workflow:
        1. Trigger deploy.dev for the current branch.
        2. Poll deploy.status until it terminates.
        3. On success, capture the dev URL via deploy.url_for_branch and
           post a comment on the PR linking to it.
        4. On failure, capture deploy.logs (last 200 lines) and post them
           as a PR comment so a human can debug.

      You do not promote to production. Production promotion is gated on
      explicit human approval from the digest UI.
    skills:
      - deploy.dev
      - deploy.status
      - deploy.logs
      - deploy.url_for_branch
      - repo.git.open_pr
      - repo.git.comment_pr
  observation:
    kind: Observation
    description: |
      Watches the dev deploy after it lands. Resolves the deployed URL, runs
      a smoke check, and files a synthetic intent if the page is unhealthy
      (non-2xx, missing expected text, error string in body). Read-only — the
      next run reacts to the intent, not this one.
    systemPrompt: |
      You are the Observation agent. Run after a successful dev deploy.

      Workflow:
        1. Resolve the dev URL for the current branch via deploy.url_for_branch.
           If no URL is available, exit cleanly — there is nothing to check.
        2. Run web.smoke_check against that URL. Assert HTTP 2xx. If the
           project supplied keyword expectations in memory, pass them as
           mustContain / mustNotContain.
        3. If the smoke check fails, file a synthetic intent describing the
           failure (URL, status, failure list, first 400 bytes of body) so
           tomorrow's discovery run can act on it.
        4. Store a "last smoke" memory note so subsequent runs know whether
           the deploy was healthy.

      Do not retry forever. Do not log the body of healthy responses — the
      brief summary is enough.
    skills:
      - deploy.url_for_branch
      - web.smoke_check
      - tracker.create_issue
      - memory.recall
      - memory.store
  bug_triage:
    kind: BugTriage
    description: |
      Watches post-deploy errors. Files a new tracker issue when a fresh
      error fingerprint appears or an existing error rate spikes.
    systemPrompt: |
      You are the Bug Triage agent. Run after deploy_dev to catch
      regressions early.

      Workflow:
        1. List errors from the last hour.
        2. Compare fingerprints against memory of known errors.
        3. For any new fingerprint or any existing error whose rate
           increased meaningfully, file a tracker issue with: title,
           one-paragraph context, fingerprint, sample stack trace.
        4. Store the seen fingerprints in memory so future runs do not
           refile them.

      Do not file duplicates. If nothing is new, say so and exit.
    skills:
      - errors.list_recent
      - tracker.create_issue
      - memory.store
  doc_writer:
    kind: DocWriter
    description: |
      Updates documentation to match the code that landed this run.
      Touches docs only — no code changes.
    systemPrompt: |
      You are the Doc Writer. Run after deploy_dev to keep documentation
      in sync with what landed.

      Workflow:
        1. Read the changeset summary.
        2. For each meaningful change, decide whether existing docs need
           an update (README, docs/**, route docs, type docs).
        3. Make the minimal update. Preserve existing tone and structure.
        4. Commit with a short message referencing the changeset.

      You only edit documentation files. If a change has no documentation
      surface, do not invent one.
    skills:
      - repo.read_file
      - repo.write_file
      - llm.draft_release_notes
      - repo.git.commit
skills: {}
`;

let _cached: MergecrewConfig | null = null;

export function defaultConfig(): MergecrewConfig {
  if (!_cached) {
    _cached = parseMergecrewYaml(DEFAULT_MERGECREW_YAML).parsed;
  }
  // Defensive deep-clone so callers can mutate without poisoning the cache.
  return JSON.parse(JSON.stringify(_cached));
}
