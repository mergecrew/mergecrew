# Domain model

Conceptual entities and their relationships. The data model (`docs/02-architecture/09-data-model.md`) translates these to tables; this doc is the language used everywhere else.

## Glossary

- **Organization** — the multi-tenant unit. Owns billing identity, members, projects.
- **Member** — a user, granted one role per organization via a Membership.
- **Role** — one of `owner`, `admin`, `operator`, `viewer`.
- **Project** — a workspace bound to one repo + a Lifecycle + DeployTargets.
- **ConnectedRepo** — the GitHub-side identity (installation id, repo id, default branch).
- **DeployTarget** — `dev` | `staging` | `prod`, each with a typed adapter config.
- **Lifecycle** — versioned graph of Workflows that defines the project's daily process.
- **Workflow** — a node in the lifecycle (e.g., `discovery`, `pm`, `implementation`, `qa`, `deploy_dev`, `triage`).
- **Transition** — an edge between workflows, optionally annotated with a Gate.
- **Gate** — `auto` | `notify` | `require-approval`, with optional escalation conditions (path patterns, sensitive heuristics).
- **AgentKind** — a *type* of agent (e.g., `BackendEngineer`, `PMAgent`). Defined in code or in `mergecrew.yaml`.
- **Agent** — an *instance* of an AgentKind attached to a Workflow within a Project, with a model assignment, skill list, and don't-touch policy.
- **SkillKind** — a *type* of skill (e.g., `repo.write_file`, `deploy.dev`). Defined in code or in `mergecrew.yaml`.
- **Skill** — an *instance* of a SkillKind bound to an Agent, with optional config (e.g., a Vercel project ID).
- **DailyRun** — a single execution of the lifecycle for a project on a date.
- **WorkflowRun** — execution of one workflow within a DailyRun.
- **AgentStep** — one turn of one agent within a WorkflowRun. Has prompts, model turns, tool calls, output.
- **ToolCall** — a single invocation of a Skill from an AgentStep.
- **ModelTurn** — a single call to an LLM provider from an AgentStep (request, response, tokens, cost).
- **Changeset** — a coherent unit of work that produced a PR + dev deploy. Has a Decision, eventually.
- **PR** — pull request created on the connected repo, against a configured base branch.
- **DevDeploy** — the result of triggering the dev deploy adapter for the changeset's branch.
- **TestResult** — the result of QA agent's last verdict for the changeset.
- **Decision** — `promote` | `rollback` | `defer`, attributed to a user.
- **PromotedDeploy** — production deploy resulting from one or more Promote decisions.
- **ApprovalRequest** — a pending human-gate, addressed to org members with the right role.
- **IntentInboxItem** — a free-text intent injected by a user into a project's inbox.
- **Provider** — an LLM provider config (e.g., `anthropic-org-key-1`).
- **LlmProfile** — a named bundle of provider preferences and capability routing rules.
- **LlmInvocation** — one row per model call, used for cost ledger and observability.
- **TimelineEvent** — append-only log entry rendered in the timeline UI.
- **Memory** — a project-scoped key/text/embedding store accessible via `memory.*` skills.
- **AuditLogEntry** — security-relevant action (auth, secret edits, role changes).

## Cardinalities

```
Organization 1—n Membership n—1 User
Organization 1—n Project
Project      1—1 ConnectedRepo
Project      1—n DeployTarget
Project      1—1 Lifecycle (latest, with versioned history)
Lifecycle    1—n Workflow
Workflow     1—n Agent
Agent        1—n Skill
Workflow     1—n Transition (out)
Transition   1—1 Gate

Project    1—n DailyRun
DailyRun   1—n WorkflowRun
WorkflowRun 1—n AgentStep
AgentStep  1—n ToolCall
AgentStep  1—n ModelTurn

Project    1—n Changeset
Changeset  1—1 PR
Changeset  1—1 DevDeploy
Changeset  1—n TestResult       (latest selected by recency)
Changeset  1—n Decision         (history)
Changeset  0—1 PromotedDeploy

Project   1—n ApprovalRequest
Project   1—n IntentInboxItem

Organization 1—n Provider
Organization 1—n LlmProfile
WorkflowRun  1—n LlmInvocation  (rolled up to AgentStep)

Project   1—n TimelineEvent
Project   1—n Memory
Organization 1—n AuditLogEntry
```

## Key invariants (enforced at API & DB)

- Every row carries `organization_id` and obeys the active session's tenancy.
- A `Project` has exactly one `prod` `DeployTarget` and at least one `dev` target.
- A `Changeset` cannot reach `PromotedDeploy` without a `Decision { kind: promote }` from a user with role ≥ `operator`.
- A `Decision` is immutable; corrections create a new Decision (e.g., a "promote" followed by a "rollback").
- An `ApprovalRequest` blocks its referenced `WorkflowRun` from advancing past the gate.
- A `DailyRun` has at most one in-flight execution per project at a time.
- A `Lifecycle` change creates a new versioned Lifecycle row; in-flight runs continue with the version they started under.
- A `mergecrew.yaml` change in the repo triggers a Lifecycle reconciliation when next a run starts; mid-run config swaps are not allowed.

## Lifecycle definition shape

```yaml
# mergecrew.yaml (excerpt)
version: 1
lifecycle:
  workflows:
    - id: discovery
      agents: [discovery]
      out: [pm]
    - id: pm
      agents: [pm]
      out: [design, implementation]    # fan-out per intent
      transitions:
        - to: design
          when: "intent.requires_ui_change"
          gate: auto
        - to: implementation
          when: "true"
          gate: auto
    - id: design
      agents: [ux_designer]
      out: [implementation]
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
        - to: pm                       # bounce-back loop
          when: "tests.failed"
          gate: auto
    - id: deploy_dev
      agents: [sre]
      out: [observation]
    - id: observation
      agents: [bug_triage, doc_writer]
      out: []
  human_gates:
    production_promote: require-approval   # not editable
    sensitive_path_patterns:
      - "apps/*/src/auth/**"
      - "apps/*/src/billing/**"
      - "**/migrations/**"
agents:
  backend_engineer:
    model: capability:reasoning+tools+200k
    fallback:
      - bedrock/anthropic.claude-opus-4-7
      - openai/gpt-5-codex
    skills: [repo.*, build.*, deploy.dev, deploy.status]
    do_not_touch: ["apps/*/src/auth/**", "apps/*/src/billing/payments/**"]
  # …
```

The shape is parsed into the domain entities at run start.

## State machine: DailyRun

```
        ┌─────────┐
        │ pending │   created by worker-cron at scheduled time
        └────┬────┘
             ▼
       ┌──────────┐
       │ running  │
       └─┬──────┬─┘
         │      │
   ┌─────┘      └──────┐
   ▼                   ▼
┌──────────────┐    ┌──────────────────┐
│ paused-rate  │    │ paused-gate      │
│ -limit       │    │ (await human)    │
└──────┬───────┘    └─────────┬────────┘
       │                      │
       └──────┬───────────────┘
              ▼
         ┌──────────┐
         │ running  │  (resumed)
         └──┬───┬───┘
            │   │
       ┌────┘   └────┐
       ▼             ▼
   ┌────────┐    ┌────────┐
   │ done   │    │ failed │
   └────────┘    └────────┘
```

## State machine: Changeset

```
   ┌──────────┐
   │ proposed │  PM agent produced a spec
   └────┬─────┘
        ▼
   ┌──────────┐
   │ building │  agents writing code
   └────┬─────┘
        ▼
   ┌──────────┐
   │ testing  │  QA agent running checks
   └────┬───┬─┘
        │   └────────────┐
        ▼                ▼
   ┌──────────┐    ┌────────────────┐
   │ pr_open  │    │ tests_failed   │
   └────┬─────┘    └─────┬──────────┘
        ▼                │
   ┌──────────┐          │
   │ deployed │          │
   │ (dev)    │          │
   └──┬─────┬─┘          │
      │     │            ▼
      │     │      ┌──────────────────┐
      │     │      │ awaiting_fix     │
      │     │      └──────┬───────────┘
      │     │             │
      │     ▼             │
      │  ┌────────────────┴────┐
      │  │ flagged             │   sensitive area, awaiting human
      │  └────┬────────────────┘
      ▼       ▼
   ┌──────────────┐
   │ awaiting     │   in the digest
   │ _decision    │
   └────┬───┬───┬─┘
        │   │   │
        ▼   ▼   ▼
   promote  defer  rollback
        │
        ▼
   ┌────────────┐
   │ promoted   │
   └────┬───────┘
        ▼  (later)
   optional rollback-from-prod
```
