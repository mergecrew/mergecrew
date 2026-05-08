# Roadmap

This roadmap sequences the work across V0 (foundation), V1 (the shippable product), V1.x (post-launch hardening), V2 (broader fit), and V3 (enterprise). Each milestone has an exit criterion. Dates are intentionally absent — we ship on criteria, not calendar.

## V0 — Foundation (4–6 weeks)

The skeleton. Nothing user-facing; everything plumbed.

### V0.1 — Monorepo + skeleton services
- Monorepo with `apps/{web,api,runner,orchestrator}` and `packages/{domain,llm,skills,adapters-*,db,eventlog,agent-runtime,config-yaml}`.
- Postgres schema for identity + projects + lifecycle (lifecycle/runs schemas can be stubbed).
- Auth: email + GitHub OAuth login via NextAuth.
- A NestJS `api` that returns `/v1/auth/session` and lists empty `/v1/orgs`.
- Vercel deployment of `apps/web`; ECS deployment of `apps/api`.

**Exit criterion.** A user can sign up, create an org, and see an empty Projects page.

### V0.2 — LLM abstraction
- `packages/llm` with `LLMProvider` interface, `AnthropicProvider`, `OpenAIProvider`.
- Capability declarations and `CapabilityRouter`.
- `LlmInvocation` write path on every chat call.
- Cost ledger reads.

**Exit criterion.** A test harness can run `chat()` against either provider with the same code, and `LlmInvocation` rows appear in Postgres.

### V0.3 — Skills SDK + first skills
- `packages/skills` with `SkillDefinition` interface and conformance tests.
- Implementations of: `repo.read_file`, `repo.write_file`, `repo.list_paths`, `build.run_typecheck`, `build.run_unit_tests`, `llm.summarize`.
- Per-skill timeouts, output-schema validation, side-effect classification.

**Exit criterion.** A skills harness invokes `repo.write_file` against a sandbox workspace and verifies the on-disk effect.

### V0.4 — Agent runtime (provider-agnostic loop)
- `packages/agent-runtime` with the loop described in the agentic-runtime architecture doc.
- Stub orchestrator: a single-step in-process scheduler.
- A "hello agent" that takes "write a TODO into README.md and explain why" → does it.

**Exit criterion.** From a CLI, run a one-step agent against a local git workspace; commit appears in the workspace; transcript blob written to S3.

### V0.5 — VCS + GitHub Actions deploy adapters
- `packages/adapters-vcs` with GitHubProvider (clone, branch, commit, push, openPR, mergePR, revertPR).
- `packages/adapters-deploy` with GitHubActionsProvider.
- A small test repo in the engineering org used as the dogfood target.

**Exit criterion.** From a CLI, given the test repo, the agent edits a file, opens a PR, triggers the test repo's `deploy-dev.yml`, retrieves the dev URL.

## V1 — Product (8–12 weeks after V0)

The real product. Multi-tenant, scheduled runs, digest, promote/rollback, the end-to-end loop.

### V1.0 — Tenancy + RLS + roles
- All tables tenant-stamped.
- RLS policies + the `mergecrew_app` role.
- `TenantInterceptor` and per-request org context.
- Membership + roles + `@RequireRole` decorator.
- Audit log core.

**Exit criterion.** Two test orgs cannot read each other's data through the API; a test that simulates the swap proves it.

### V1.1 — Projects, Inception, deploy targets
- Connect-GitHub flow + GitHub App install.
- Project Inception (stack detection, `mergecrew.yaml` draft).
- Project setup wizard (web + mobile).
- Deploy target configuration UI for GitHub Actions.
- Smoke-test deploy at onboarding.

**Exit criterion.** A new tenant can connect a real repo, configure GitHub Actions deploy, and run the smoke test successfully.

### V1.2 — Lifecycle, agents, skills (config + UI)
- `mergecrew.yaml` parser + validator.
- Default Lifecycle ships in code; merged with project config at run start.
- Lifecycle viewer (read-only) in the UI.
- Agent settings page (per-agent model override, fallbacks).
- Custom skill registration via `mergecrew.yaml`.

**Exit criterion.** A project can declare a custom lifecycle in `mergecrew.yaml`; it parses, renders, and is used at the next run.

### V1.3 — Orchestrator (durable engine on Postgres + BullMQ)
- DailyRun / WorkflowRun / AgentStep tables.
- Durable dispatcher with at-least-once + idempotency.
- Rate-limit pause-and-resume (full path).
- Gate pause-and-resume.
- Cancellation.
- Per-org concurrency caps.

**Exit criterion.** A simulated run with injected 429s and gate triggers completes without manual intervention.

### V1.4 — Runner pool + workspace isolation
- Fargate-based runner with per-step working dir + cgroup limits + egress allowlist.
- Streamed timeline events from runner to Redis pubsub.
- Heartbeat-based dead-runner recovery in the orchestrator.

**Exit criterion.** Killing a runner mid-step results in the step being re-dispatched and completing.

### V1.5 — Real-time UI (timeline + transcript)
- SSE timeline endpoint and renderer.
- Per-agent transcript with collapsible tool calls.
- Mobile-first density mode.
- Replay parity (yesterday's run renders identically).

**Exit criterion.** A live run streams to two browser sessions in real time; both show the same state; reconnect after drop catches up correctly.

### V1.6 — Changesets, PRs, dev deploys
- Changeset state machine.
- PR opening with the structured PR body.
- Dev deploy via configured adapter; URL surfaced on the changeset.
- Test summary captured.

**Exit criterion.** An automated end-to-end test starts a run, the run produces a changeset, the dev deploy is reachable.

### V1.7 — Digest + promote/rollback
- Digest assembly at end of working hours.
- Mobile-first digest UI.
- Slack DM with one-tap actions.
- Email digest.
- Per-changeset Promote / Rollback / Defer.
- Group-promote.

**Exit criterion.** A user can review yesterday's run on their phone and promote 3 of 5 changesets in under 60 seconds.

### V1.8 — Bug Triage + Observation loop
- Sentry integration.
- Bug Triage agent picks up errors, attempts fix, files as a changeset.
- Observation agent post-deploy: hits the dev URL, checks for obvious regressions.

**Exit criterion.** A planted Sentry error in dev causes a Bug Triage changeset to appear in the next digest.

### V1.9 — Bedrock + Ollama providers
- Bedrock implementation (Anthropic-on-Bedrock first; Mistral/Meta after).
- Ollama implementation with capability probe.
- Profile-based fallover paths fully exercised.

**Exit criterion.** A test project with a profile `[anthropic, bedrock-anthropic, openai]` survives a forced primary outage.

### V1.10 — Hardening + dogfood
- Mergecrew runs Mergecrew in staging.
- Two weeks of unsupervised daily runs; bugs fixed via Mergecrew itself.
- Performance tuning (DB indexes, queue throughput, SSE fanout).

**V1 exit criterion.** Mergecrew dogfoods Mergecrew for two consecutive weeks producing ≥ 5 promoted changesets/week on the Mergecrew codebase, with no manual orchestrator intervention.

## V1.x — Post-launch hardening (rolling)

- MFA mandatory for admins.
- Per-org daily $ budgets with hard stop.
- Cost dashboard.
- Linear + Intercom integrations.
- Vision input (screenshot-aware design review agents).
- Inline diff comments on pending changesets (Riley persona).
- SOC 2 Type 2 audit started.
- Scheduled runs honoring custom calendars (skip weekends, holidays).

## V2 — Broader fit (3–6 months after V1)

### V2.1 — Visual lifecycle editor
- Drag-and-drop nodes for the lifecycle graph.
- Edit-and-commit semantics: edits open a PR against `mergecrew.yaml`.

### V2.2 — More deploy adapters
- AWS-direct (no GitHub Actions middle): ECS, Lambda, Cloudfront/S3.
- Fly.io.
- Render.
- Railway.
- Conformance test suite for adapter authors.

### V2.3 — More VCS adapters
- GitLab.
- Gitea.
- GitHub Enterprise (self-hosted) — same adapter, different base URL.

### V2.4 — Public API + SDKs
- TypeScript and Python SDKs.
- Programmatic project creation, intent injection, run control.
- Outbound webhooks for run/changeset events.

### V2.5 — Multi-repo projects
- A Project owns N ConnectedRepos.
- Cross-repo coordination (shared types, cross-repo PR linking).

### V2.6 — Mergecrew as token reseller
- A managed-LLM tier where Mergecrew supplies the keys and meters tokens.
- Pricing model and budget controls.
- Optional: BYOK remains available.

### V2.7 — Auto-promote allowlists
- Path patterns / change classes that auto-promote without human review (doc-only, dependency patch bumps, content updates).
- Audit visibility into auto-promotion decisions.

## V3 — Enterprise (6–12 months after V1)

- SAML / SCIM SSO.
- Customer-managed keys (CMEK).
- Dedicated VPC / dedicated DB tier.
- Self-hosted runner (the runner runs in customer infra; control plane stays SaaS).
- Audit log streaming to customer SIEMs.
- Compliance: HIPAA-ready controls, FedRAMP roadmap.
- On-call / incident response automation (post-deploy, watch metrics, page humans).
- Marketplace of community-contributed agents and skills.

## Engineering principles for the roadmap

- **No skipping V0.** The platform's reliability story is built on the abstractions in V0; rushing past them produces fragility we'll pay for in V1.x.
- **Dogfood gates each milestone.** No V1 milestone is "done" until it's used by Mergecrew engineering on the Mergecrew codebase.
- **The production-promote gate is a fixed product law from V1.0 onward.** Every other gate is configurable; this one is not.
- **Public API after the contract is stable.** V1 keeps the API internal; V2 publishes after it's been exercised by the web app for months.
- **No premature horizontal scale work.** Single-region until tenant load demonstrates the need.
