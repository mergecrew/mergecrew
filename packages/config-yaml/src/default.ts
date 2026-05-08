import type { MergecrewConfig } from '@mergecrew/domain';
import { parseMergecrewYaml } from './parse.js';

export const DEFAULT_MERGECREW_YAML = `version: 1
lifecycle:
  workflows:
    - id: discovery
      agents: [discovery]
      out: [pm]
    - id: pm
      agents: [pm]
      out: [implementation]
      transitions:
        - to: implementation
          when: "true"
          gate: auto
    - id: implementation
      agents: [backend_engineer, frontend_engineer]
      out: [qa]
    - id: qa
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
      agents: [sre]
      out: [observation]
    - id: observation
      agents: [bug_triage, doc_writer]
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
    skills: [tracker.list_issues, errors.list_recent, memory.recall, llm.summarize]
  pm:
    kind: PM
    skills: [llm.draft_spec, memory.recall, memory.store]
  backend_engineer:
    kind: BackendEngineer
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
    skills:
      - build.run_install
      - build.run_typecheck
      - build.run_lint
      - build.run_unit_tests
      - build.run_integration_tests
  sre:
    kind: SRE
    skills:
      - deploy.dev
      - deploy.status
      - deploy.logs
      - deploy.url_for_branch
      - repo.git.open_pr
      - repo.git.comment_pr
  bug_triage:
    kind: BugTriage
    skills:
      - errors.list_recent
      - tracker.create_issue
      - memory.store
  doc_writer:
    kind: DocWriter
    skills:
      - repo.read_file
      - repo.write_file
      - llm.draft_release_notes
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
