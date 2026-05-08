# Scope

This document defines what is in and out of scope for the first shippable version (V1) and explicitly defers items to later phases. The roadmap (`docs/04-roadmap.md`) sequences these.

## V1 scope (what must ship)

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
- Visual lifecycle editor (read-only in V1; edit via JSON/YAML config — visual editor is V2).
- Library of stock agents (PM, UX Designer, Backend Engineer, Frontend Engineer, QA, SRE, Bug Triager, Doc Writer).
- Library of stock skills (read repo, write file, run tests, open PR, run lint, deploy preview, fetch deploy logs, screenshot URL, query Linear/Jira, post Slack).
- Per-agent and per-skill model assignment, with per-org defaults.

### Daily run engine
- Per-project schedule (cron-like, with a default: "every weekday at user's working-hours start").
- Manual "Run now" trigger.
- Durable execution: a run survives process restarts and provider rate-limit pauses.
- Provider rate-limit & quota awareness: 429 / quota errors trigger a sleep that respects `Retry-After`, then resumes.
- Run isolation: agents work in per-run sandboxed working trees on a shared runner pool.

### Human-in-the-loop
- Configurable gate per workflow transition: `auto`, `notify`, `require-approval`.
- Sane defaults (see §"Default human-gate policy" below).
- Approval inbox in the UI; Slack DM and email notifications.
- Hard gate: production promotion always requires a human decision in V1. (This is a product invariant, not a setting.)

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
- Per-org BYOK (bring-your-own-key) model: tenant supplies API keys; Mergecrew does not resell tokens in V1.
- Fallback chains (e.g., "try Anthropic Sonnet, fall back to Bedrock Claude on 429").

### Observability
- Per-run cost ledger (tokens × price by provider).
- Replayable transcripts.
- Health metrics: run success rate, gate-wait time, time-to-promote, rollback rate.

## Out of scope for V1 (explicitly deferred)

- Visual workflow editor with drag-and-drop nodes (V2).
- Marketplace of community-contributed agents/skills (V3).
- Self-hosted Mergecrew runner (V3).
- Mergecrew-managed dev environments (Replit-style) — V1 only orchestrates existing pipelines and Vercel.
- Multi-repo projects (one project = one repo in V1).
- Mobile app deploy targets (App Store / Play Store automation).
- Mergecrew as an LLM token reseller / metered billing on tokens (V2, after BYOK proves out).
- Fine-tuning / RLHF on tenant data.
- On-call / incident response automation (V3).

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

## Constraints on V1

- The Mergecrew platform itself runs as multi-tenant from day one (single-tenant code is technical debt we're not paying).
- Two reference projects must be supported end-to-end before V1 ships:
  1. **Mergecrew dogfoods Mergecrew** — Mergecrew's own NestJS+Next.js codebase deploys via GitHub Actions to AWS.
  2. **A new greenfield project** scaffolded inside Mergecrew, deployed via Vercel + Neon.
- All persistent state must be in PostgreSQL or object storage. No agent state in process memory across restarts.

## Definition of "V1 done"

- A new tenant can sign up, connect a GitHub repo, run a daily loop unattended for 24 hours, and arrive in the morning at a digest with at least one changeset to review.
- Promotion to production from the digest works in one click and is reversible.
- A provider rate-limit during a run does not cause the run to fail; it pauses and resumes.
- The same tenant can swap between Anthropic, OpenAI, Bedrock, and Ollama for at least one agent without code changes.
