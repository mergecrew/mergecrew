# Scope

This document defines what the Mergecrew project covers — the surface area of the codebase — versus what is explicitly out of scope. Sequencing of in-scope work lives in the roadmap (`docs/04-roadmap.md`); near-term issues live on GitHub.

## In scope

### Tenancy & identity
- Organizations, members, roles (Owner, Admin, Operator, Viewer).
- Email + OAuth (Google, GitHub) sign-in.
- Per-org settings: timezone, working hours, default models, default human-gate policy.
- Multi-tenant data isolation enforced at the database layer.

### Projects
- A Project = one GitHub repo + one or more deploy targets + one Lifecycle.
- Connect-GitHub flow (GitHub App install, repo selection).
- Connect-deploy flow:
  - Adapter: **GitHub Actions** (trigger a `workflow_dispatch` and watch the run; user supplies the workflow filename and any required inputs). This is the bridge to existing AWS pipelines.
  - Adapter: **Vercel** (opinionated default for new projects scaffolded inside Mergecrew).
- Project-level secret store (encrypted, scoped, never logged).

### Lifecycle, workflows, agents, skills
- A starter **Default Lifecycle** that ships out of the box and is good enough to run day one.
- Lifecycle config edited as JSON/YAML in `mergecrew.yaml` and via the in-app config editor.
- Library of stock agents (PM, UX Designer, Backend Engineer, Frontend Engineer, QA, SRE, Bug Triager, Doc Writer).
- Library of stock skills (read repo, write file, run tests, open PR, run lint, deploy preview, fetch deploy logs, screenshot URL, query Linear/Jira, post Slack).
- Per-agent and per-skill model assignment, with per-org defaults.

### Daily run engine
- Per-project schedule (cron-like, with a default: "every weekday at user's working-hours start").
- Manual "Run now" trigger.
- Durable execution: a run survives process restarts and provider rate-limit pauses.
- Provider rate-limit & quota awareness: 429 / quota errors trigger a sleep that respects `Retry-After`, then resumes.
- Run isolation: agents work in per-run sandboxed working trees. Default driver is `docker` (per-run OCI container); the supervisor's `RUNNER_SANDBOX` selects between `process / docker / k8s / fargate`.
- Per-org runner ownership (V2.af): each org picks an `instance-builtin` (the operator's pool, gated by a trusted-org allowlist), an `agent` (BYO — the org runs `mergecrew/runner-agent` on its own machine), a `fargate-byo` (ECS task in the org's AWS account via STS role-assumption — no stored AWS keys), or a `github-actions` (planned) runner profile.

### Human-in-the-loop
- Configurable gate per workflow transition: `auto`, `notify`, `require-approval`.
- Sane defaults (see §"Default human-gate policy" below).
- Approval inbox in the UI; Slack DM and email notifications.
- Hard gate: production promotion always requires a human decision. (This is a product invariant, not a setting.)

### Real-time visibility
- Live timeline of agent activity per project, streamed to the browser.
- Per-agent transcript with prompts, tool calls, and outputs (collapsible).
- Daily digest at end of day: list of changesets with diff summary, dev URL, screenshot, test status.

### Promote / rollback
- Per-changeset actions: promote (merge + production deploy) / rollback (revert PR or undeploy preview) / defer (keep on dev).
- Atomic group-promote (promote multiple changesets as one production deploy).
- Audit trail of every promotion/rollback decision.

### LLM provider abstraction
- Pluggable providers behind one interface: **Anthropic**, **OpenAI** (incl. Codex-style coding models), **AWS Bedrock**, **Ollama** (local).
- Per-skill capability requirements (tool use, vision, long context, embeddings).
- Per-org BYOK (bring-your-own-key) model: operators supply API keys; the project does not act as a token reseller.
- Fallback chains (e.g., "try Anthropic Sonnet, fall back to Bedrock Claude on 429").

### Observability
- Per-run cost ledger (tokens × price by provider).
- Replayable transcripts.
- Health metrics: run success rate, gate-wait time, time-to-promote, rollback rate.

## Explicitly out of scope

- Visual workflow editor with drag-and-drop nodes.
- Marketplace of community-contributed agents/skills.
- Mergecrew-managed dev environments (Replit-style) — Mergecrew orchestrates existing pipelines and Vercel, not its own runtime.
- Multi-repo projects (one project = one repo).
- Mobile app deploy targets (App Store / Play Store automation).
- Mergecrew as an LLM token reseller / metered billing on tokens.
- Fine-tuning / RLHF on tenant data.
- On-call / incident response automation.

## Default human-gate policy (out of the box)

| Lifecycle node | Default gate | Rationale |
|---|---|---|
| Discovery → Spec | `notify` | User sees the spec but it doesn't block. |
| Spec → Design | `auto` | UI design is cheap to redo. |
| Design → Implementation | `auto` | Code is cheap to redo. |
| Implementation → QA | `auto` | Internal step. |
| QA → Dev deploy | `auto` | Dev is the safe sandbox. |
| Dev deploy → Production | `require-approval` (always) | Hard product invariant. |
| Bug detected → Auto-fix attempt | `auto` | Dev-only side effects. |
| Auth/payments/PII code change | `require-approval` | Heuristic flag; tightened by default. |
| Schema migration | `require-approval` | Irreversible class of change. |
| Dependency major version bump | `require-approval` | Wide blast radius. |
| Dependency patch/minor bump | `auto` | Low risk. |
| Doc-only change | `auto` | Zero blast radius. |

The policy is editable per project; the production hard gate is not.

## Architectural constraints

- Mergecrew runs as multi-tenant from day one (single-tenant code is technical debt the project does not pay).
- All persistent state lives in PostgreSQL or object storage. No agent state is held in process memory across restarts.
