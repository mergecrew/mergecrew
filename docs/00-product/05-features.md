# Feature breakdown

Concrete feature inventory grouped by surface. Each feature has a brief description, the primary persona it serves, and an implementation status: `Implemented` (working in the current codebase), `In progress` (partially landed), or `Planned` (designed but not yet built; tracked in roadmap / GitHub Issues).

## Identity & tenancy

| Feature | Persona | Status |
|---|---|---|
| Email + Google + GitHub OAuth | All | Implemented (GitHub OAuth); email + Google Planned |
| Organization with members & roles (Owner/Admin/Operator/Viewer) | All | Implemented |
| Per-org timezone, working hours, default models | Theo, Mira | Implemented |
| Per-org BYOK secret store (Anthropic / OpenAI / AWS / Ollama endpoint) | All | Implemented |
| Org-level audit log | Mira | Implemented |
| SAML/SCIM SSO | Enterprise | Planned |

## Projects

| Feature | Persona | Status |
|---|---|---|
| Connect-GitHub (GitHub App install + repo selection) | All | Implemented |
| Project Inception (auto-detect stack, CI, tests; emit `mergecrew.yaml`) | All | Planned |
| Seeded per-org `demo-saas` project with completed sample run | Theo (day-zero) | Implemented (`Project.demo = true`; mutations rejected 403) |
| Coachmark tour over the demo project's timeline → digest → review | Theo (day-zero) | Implemented |
| Inverted FTE: new orgs land in `demo-saas`; "Set up your own project →" CTA → onboarding wizard | Theo (day-zero) | Implemented |
| Per-project secret store (encrypted, scoped) | All | Implemented |
| Per-project policy: don't-touch path patterns, sensitive-area heuristics | Mira | In progress |
| Project archive / unarchive | All | Implemented |
| Multi-repo project | Mira | Planned |
| New-project scaffolding (Next.js + NestJS + Prisma + Vercel) | Theo (greenfield) | Planned |

## Lifecycle, workflows, agents, skills

| Feature | Persona | Status |
|---|---|---|
| Default Lifecycle out of the box | All | Implemented |
| Stock lifecycle templates (`roster` (default), `generic-careful` (legacy 3-agent loop), `nextjs-vercel`, `python-render`, `go-fly`) selectable from the project Lifecycle page | All | Implemented |
| Lifecycle defined as YAML in `mergecrew.yaml` (versioned with the repo) | All | Implemented |
| Visual lifecycle viewer (DAG render of nodes + edges) | All | Implemented (`apps/web/src/components/lifecycle/lifecycle-graph.tsx`) |
| Visual lifecycle editor (drag-drop nodes) | All | Planned |
| Stock agents library (PM, UX, FE, BE, QA, SRE, Bug Triager, Doc Writer) | All | Implemented |
| Custom agent definitions in `mergecrew.yaml` | Mira | Implemented |
| `description:` field on agents and workflows (rendered on Lifecycle + Agents pages) | Mira | Implemented (lifecycle YAML schema only — not a Prisma column) |
| Multi-agent specialization | Mira | Implemented — `roster` profile (default) drives the 9-agent Discovery → PM → Implementation (BE + FE) → QA → DeployDev → Observation (DesignReviewer + Observation + BugTriage + DocWriter) graph with loop-backs; the legacy `careful` profile (planner → coder → reviewer) is still supported. See [`03-infrastructure/18-multi-agent.md`](../03-infrastructure/18-multi-agent.md). |
| Stock skills library (~25 skills, see §Skills below) | All | In progress |
| Custom skill definitions (OpenAPI / JSON-schema-shaped) | Mira | Planned |
| Per-agent and per-skill model assignment with capability requirements | Mira | Implemented |
| Marketplace of community-contributed agents/skills | All | Planned |

## Daily run engine

| Feature | Persona | Status |
|---|---|---|
| Per-project schedule (cron-shaped, timezone-aware) | All | Implemented |
| Manual "Run now" trigger | All | Implemented |
| Live timeline of agent activity (SSE) | All | Implemented |
| Per-agent transcript with prompts & tool calls | Mira | Implemented |
| Per-run cost ledger | Mira | Implemented |
| Provider rate-limit aware pause/resume | All | Implemented |
| Provider fallback chains | All | Implemented |
| Mid-run config edits (apply on next run) | Mira | Implemented |
| Mid-run config edits (apply immediately) | Mira | Out of scope |
| Per-org concurrent-step cap (orchestrator defers the (N+1)-th dispatch) | Platform | Implemented (`organizations.org_concurrency_cap`; surfaced in **Settings → Runner**) |

## Human-in-the-loop

| Feature | Persona | Status |
|---|---|---|
| Per-transition gate config: `auto` / `notify` / `require-approval` | All | Implemented |
| Approval inbox in the web UI | All | Implemented |
| Approval via Slack DM action buttons | Theo | Planned |
| Approval via email | Theo | Planned |
| Heuristic auto-escalation (auth, payments, migrations) | Mira | In progress |
| Path-pattern based auto-escalation | Mira | In progress |
| Inline diff comments / change requests on a pending changeset | Riley | Planned |

## Promote / rollback

| Feature | Persona | Status |
|---|---|---|
| Per-changeset Promote / Rollback / Defer | All | Implemented |
| Group-promote (atomic prod deploy of N changesets) | All | In progress (API endpoint exists; UI Planned) |
| Production deploy via configured deploy adapter | All | Implemented |
| Rollback via PR revert on the dev branch | All | Implemented |
| Rollback of an already-promoted prod deploy (revert PR + redeploy) | All | Implemented |
| Feature-flag-aware promotion (ramp, gradual rollout) | Mira | Planned |
| Auto-promote allowlist (e.g., always promote doc-only changes) | Mira | Planned |

## Real-time visibility

| Feature | Persona | Status |
|---|---|---|
| Live timeline view per project | All | Implemented |
| Org-wide activity feed | Mira | Implemented |
| Per-changeset details: diff, dev URL, screenshots, tests, cost | All | In progress |
| Replayable transcript per agent | Mira | Implemented |
| Mobile-first end-of-day digest | Theo | Planned |
| Slack daily digest summary | Theo | Planned |
| Email daily digest summary | Theo | Planned |
| Public status page per project | Mira | Planned |

## LLM provider abstraction

| Feature | Persona | Status |
|---|---|---|
| Anthropic provider (Claude family) | All | Implemented |
| OpenAI provider (incl. Codex-class coding models) | All | Implemented |
| AWS Bedrock provider | Mira | Implemented |
| Ollama provider (local / self-hosted endpoint) | Mira | Implemented |
| Capability-based routing ("strong reasoning + tool use + 200k context") | Mira | Implemented |
| Per-skill, per-agent, per-org model overrides | Mira | Implemented |
| Fallback chains across providers | All | Implemented |
| Streaming responses end-to-end | All | Implemented |
| Embeddings provider abstraction | All | In progress |
| Vision input (screenshots) for design review agents | Theo | Planned |
| Token cost tracking & per-tenant budgets | Mira | In progress (cost tracking Implemented; budgets Planned) |

## Integrations

| Feature | Persona | Status |
|---|---|---|
| GitHub (App install, PR, issues) | All | Implemented |
| Draft PR + reviewer-verdict surfaced as native GitHub Review (`postReview` + `markReadyForReview`) | All | Implemented (GitHub); Gitea/GitLab no-op |
| GitHub Actions (deploy adapter) | All | Implemented |
| Vercel (deploy adapter) | Theo (greenfield) | Implemented |
| Netlify (deploy adapter) | Theo (greenfield) | Implemented |
| Slack (notifications, approvals, daily digest) | All | In progress (inbound webhook Implemented; outbound Planned) |
| Email — SMTP transport | All | Implemented |
| Email — Resend transport (`RESEND_API_KEY`) | All | Implemented |
| Linear (issue source for Discovery agent) | Mira | In progress |
| Sentry (bug source for Triage agent) | All | In progress |
| Intercom / Zendesk (customer feedback source) | Theo | Planned |
| Notion / Confluence (doc target) | Mira | Planned |
| AWS direct deploy (ECS/Lambda) — no GH Actions middle | Mira | Implemented (`aws-direct` adapter) |
| Fly / Render / Railway deploy adapters | All | Implemented |

## Stock skills (catalog)

Repo-shaped:
- `repo.read_file`, `repo.write_file`, `repo.list_paths`, `repo.search`, `repo.git.commit`, `repo.git.create_branch`, `repo.git.open_pr`, `repo.git.comment_pr`, `repo.git.revert_pr`.

Build/test:
- `build.run_install`, `build.run_typecheck`, `build.run_lint`, `build.run_unit_tests`, `build.run_integration_tests`.

Deploy:
- `deploy.dev`, `deploy.prod`, `deploy.status`, `deploy.logs`, `deploy.url_for_branch`.

Observation:
- `web.fetch_url`, `web.screenshot_url`, `web.lighthouse`, `errors.list_recent` (Sentry-shaped), `analytics.event_counts` (Posthog-shaped, Planned).

Tracker:
- `tracker.list_issues`, `tracker.create_issue`, `tracker.comment_issue`.

Comms:
- `slack.post`, `email.send_to_org_owner`.

Memory:
- `memory.recall`, `memory.store` (project-scoped vector store).

Reasoning helpers:
- `llm.summarize`, `llm.draft_spec`, `llm.draft_release_notes`.

Each skill carries a JSON-schema input/output definition, capability requirements, side-effect class (read/write/external), and a default model assignment.

## Runner & sandboxing

| Feature | Persona | Status |
|---|---|---|
| Per-run OCI sandbox (rootless docker driver, env scrub, workspace isolation) | Platform | Implemented (V1.x EPIC #555). Selected via `RUNNER_SANDBOX={process,docker,k8s,fargate}` on the supervisor. |
| Polyglot stock images (`runner-node`, `runner-python`, `runner-java`, `runner-go`, `runner-polyglot`) auto-detected from lockfiles | All | Implemented. See [`03-infrastructure/22-runner-images.md`](../03-infrastructure/22-runner-images.md). |
| `.devcontainer/devcontainer.json` honored when present | Mira | Implemented |
| BYO image ref + private-registry pull credentials | Mira | Implemented |
| Per-project resources (`runner.image`, `runner.resources`, `runner.cache.paths`, `runner.setup`) in `mergecrew.yaml` | Mira | Implemented |
| Per-run network namespace with hostname allowlist | Platform | Implemented (#573 / Phase 4). |
| Per-run DNS resolver with allowlist (NXDOMAIN otherwise) | Platform | Implemented (#574). |
| Optional egress proxy sidecar with SNI inspection + audit log | Platform | Implemented (#575). |
| Run digest surfaces blocked-outbound list per run | Mira | Implemented (#576). |
| **Per-org `runner_profile` (V2.af, [ADR-0002](../adrs/0002-per-org-runner-profile.md))**: `instance-builtin`, `agent`, `fargate-byo`, `github-actions`, `none`. | All | Implemented |
| Trusted-org gating for `instance-builtin` via `MERGECREW_TRUSTED_ORG_SLUGS` ([ADR-0006](../adrs/0006-trusted-org-gating.md)) | Platform | Implemented |
| Default profile = `none`; runs blocked at scheduling ([ADR-0008](../adrs/0008-default-profile-none.md)) | Platform | Implemented |
| BYO runner-agent: `mergecrew/runner-agent` Docker image + long-poll job-pull protocol (#766) | Mira | In progress — protocol scaffolding shipped; agent-side executor stub until #782 (see [ADR-0009](../adrs/0009-byo-agent-as-remote-sandbox-driver.md)) |
| BYO Fargate (STS role-assumption, no stored AWS keys, [ADR-0007](../adrs/0007-byo-cloud-credentials.md)) | Mira | In progress — config + trust-policy docs shipped; dispatcher pending #786 |
| BYO GitHub Actions profile (`workflow_dispatch`) | Mira | Planned — #772, depends on #782 |
| Org settings UI for runner profile + online/offline agent badge | Owner/Admin | Implemented |
| Runner-agent enrollment + revoke (one-shot token, audit log) | Owner/Admin | Implemented |

## Settings & administration

| Feature | Persona | Status |
|---|---|---|
| Org settings page | Owner/Admin | Implemented |
| Project settings page | Owner/Admin | Implemented |
| `mergecrew.yaml` import/export | Mira | In progress |
| Member management & invitations | Owner/Admin | In progress |
| Cost dashboard (per project, per agent, per provider) | Mira | In progress |
| Webhooks (project events to user-supplied URL) | Mira | Planned |
| API keys for programmatic Mergecrew access | Mira | Planned |
