# Feature breakdown

Concrete feature inventory grouped by surface. Each feature has a brief description, the primary persona it serves, and the V1 status (`V1`, `V1.x`, `V2`, `V3`).

## Identity & tenancy

| Feature | Persona | Status |
|---|---|---|
| Email + Google + GitHub OAuth | All | V1 |
| Organization with members & roles (Owner/Admin/Operator/Viewer) | All | V1 |
| Per-org timezone, working hours, default models | Theo, Mira | V1 |
| Per-org BYOK secret store (Anthropic / OpenAI / AWS / Ollama endpoint) | All | V1 |
| Org-level audit log | Mira | V1 |
| SAML/SCIM SSO | Enterprise | V3 |

## Projects

| Feature | Persona | Status |
|---|---|---|
| Connect-GitHub (GitHub App install + repo selection) | All | V1 |
| Project Inception (auto-detect stack, CI, tests; emit `mergecrew.yaml`) | All | V1 |
| Per-project secret store (encrypted, scoped) | All | V1 |
| Per-project policy: don't-touch path patterns, sensitive-area heuristics | Mira | V1 |
| Project archive / unarchive | All | V1 |
| Multi-repo project | Mira | V2 |
| New-project scaffolding (Next.js + NestJS + Prisma + Vercel) | Theo (greenfield) | V1 |

## Lifecycle, workflows, agents, skills

| Feature | Persona | Status |
|---|---|---|
| Default Lifecycle out of the box | All | V1 |
| Lifecycle defined as YAML in `mergecrew.yaml` (versioned with the repo) | All | V1 |
| Visual lifecycle viewer (read-only) | All | V1 |
| Visual lifecycle editor (drag-drop nodes) | All | V2 |
| Stock agents library (PM, UX, FE, BE, QA, SRE, Bug Triager, Doc Writer) | All | V1 |
| Custom agent definitions in `mergecrew.yaml` | Mira | V1 |
| Stock skills library (~25 skills, see §Skills below) | All | V1 |
| Custom skill definitions (OpenAPI / JSON-schema-shaped) | Mira | V1 |
| Per-agent and per-skill model assignment with capability requirements | Mira | V1 |
| Marketplace of community-contributed agents/skills | All | V3 |

## Daily run engine

| Feature | Persona | Status |
|---|---|---|
| Per-project schedule (cron-shaped, timezone-aware) | All | V1 |
| Manual "Run now" trigger | All | V1 |
| Live timeline of agent activity (SSE) | All | V1 |
| Per-agent transcript with prompts & tool calls | Mira | V1 |
| Per-run cost ledger | Mira | V1 |
| Provider rate-limit aware pause/resume | All | V1 |
| Provider fallback chains | All | V1 |
| Mid-run config edits (apply on next run) | Mira | V1 |
| Mid-run config edits (apply immediately) | Mira | Out of scope |
| Backpressure: cap concurrent runs / agents per org | Platform | V1 |

## Human-in-the-loop

| Feature | Persona | Status |
|---|---|---|
| Per-transition gate config: `auto` / `notify` / `require-approval` | All | V1 |
| Approval inbox in the web UI | All | V1 |
| Approval via Slack DM action buttons | Theo | V1 |
| Approval via email | Theo | V1 |
| Heuristic auto-escalation (auth, payments, migrations) | Mira | V1 |
| Path-pattern based auto-escalation | Mira | V1 |
| Inline diff comments / change requests on a pending changeset | Riley | V1.x |

## Promote / rollback

| Feature | Persona | Status |
|---|---|---|
| Per-changeset Promote / Rollback / Defer | All | V1 |
| Group-promote (atomic prod deploy of N changesets) | All | V1 |
| Production deploy via configured deploy adapter | All | V1 |
| Rollback via PR revert on the dev branch | All | V1 |
| Rollback of an already-promoted prod deploy (revert PR + redeploy) | All | V1 |
| Feature-flag-aware promotion (ramp, gradual rollout) | Mira | V2 |
| Auto-promote allowlist (e.g., always promote doc-only changes) | Mira | V2 |

## Real-time visibility

| Feature | Persona | Status |
|---|---|---|
| Live timeline view per project | All | V1 |
| Org-wide activity feed | Mira | V1 |
| Per-changeset details: diff, dev URL, screenshots, tests, cost | All | V1 |
| Replayable transcript per agent | Mira | V1 |
| Mobile-first end-of-day digest | Theo | V1 |
| Slack daily digest summary | Theo | V1 |
| Email daily digest summary | Theo | V1 |
| Public status page per project | Mira | V2 |

## LLM provider abstraction

| Feature | Persona | Status |
|---|---|---|
| Anthropic provider (Claude family) | All | V1 |
| OpenAI provider (incl. Codex-class coding models) | All | V1 |
| AWS Bedrock provider | Mira | V1 |
| Ollama provider (local / self-hosted endpoint) | Mira | V1 |
| Capability-based routing ("strong reasoning + tool use + 200k context") | Mira | V1 |
| Per-skill, per-agent, per-org model overrides | Mira | V1 |
| Fallback chains across providers | All | V1 |
| Streaming responses end-to-end | All | V1 |
| Embeddings provider abstraction | All | V1 |
| Vision input (screenshots) for design review agents | Theo | V1.x |
| Token cost tracking & per-tenant budgets | Mira | V1.x |

## Integrations

| Feature | Persona | Status |
|---|---|---|
| GitHub (App install, PR, issues) | All | V1 |
| GitHub Actions (deploy adapter) | All | V1 |
| Vercel (deploy adapter) | Theo (greenfield) | V1 |
| Slack (notifications, approvals, daily digest) | All | V1 |
| Linear (issue source for Discovery agent) | Mira | V1 |
| Sentry (bug source for Triage agent) | All | V1 |
| Intercom / Zendesk (customer feedback source) | Theo | V1.x |
| Notion / Confluence (doc target) | Mira | V2 |
| AWS direct deploy (ECS/Lambda) — no GH Actions middle | Mira | V2 |
| Fly / Render / Railway deploy adapters | All | V2 |

## Stock skills (V1 catalog)

Repo-shaped:
- `repo.read_file`, `repo.write_file`, `repo.list_paths`, `repo.search`, `repo.git.commit`, `repo.git.create_branch`, `repo.git.open_pr`, `repo.git.comment_pr`, `repo.git.revert_pr`.

Build/test:
- `build.run_install`, `build.run_typecheck`, `build.run_lint`, `build.run_unit_tests`, `build.run_integration_tests`.

Deploy:
- `deploy.dev`, `deploy.prod`, `deploy.status`, `deploy.logs`, `deploy.url_for_branch`.

Observation:
- `web.fetch_url`, `web.screenshot_url`, `web.lighthouse`, `errors.list_recent` (Sentry-shaped), `analytics.event_counts` (Posthog-shaped, V1.x).

Tracker:
- `tracker.list_issues`, `tracker.create_issue`, `tracker.comment_issue`.

Comms:
- `slack.post`, `email.send_to_org_owner`.

Memory:
- `memory.recall`, `memory.store` (project-scoped vector store).

Reasoning helpers:
- `llm.summarize`, `llm.draft_spec`, `llm.draft_release_notes`.

Each skill carries a JSON-schema input/output definition, capability requirements, side-effect class (read/write/external), and a default model assignment.

## Settings & administration

| Feature | Persona | Status |
|---|---|---|
| Org settings page | Owner/Admin | V1 |
| Project settings page | Owner/Admin | V1 |
| `mergecrew.yaml` import/export | Mira | V1 |
| Member management & invitations | Owner/Admin | V1 |
| Cost dashboard (per project, per agent, per provider) | Mira | V1.x |
| Webhooks (project events to user-supplied URL) | Mira | V2 |
| API keys for programmatic Mergecrew access | Mira | V2 |
