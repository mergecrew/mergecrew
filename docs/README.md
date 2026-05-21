# Mergecrew — engineering documentation

Documentation for contributors and operators of [Mergecrew](https://github.com/mergecrew/mergecrew), the open-source agentic SDLC platform. The user-facing README is at the [project root](../README.md). This directory describes how the product is built, how it behaves, and what invariants it preserves.

## Reading order

### 0 — Product
1. [Vision](00-product/01-vision.md)
2. [Scope](00-product/02-scope.md)
3. [Personas](00-product/03-personas.md)
4. [User journeys](00-product/04-user-journeys.md)
5. [Feature breakdown](00-product/05-features.md)

### 1 — Design
1. [Design principles](01-design/01-principles.md)
2. [Information architecture](01-design/02-information-architecture.md)
3. [Key screens](01-design/03-key-screens.md)
4. [Real-time timeline UX](01-design/04-realtime-timeline.md)

### 2 — Architecture
1. [Architecture overview](02-architecture/01-overview.md)
2. [Domain model](02-architecture/02-domain-model.md)
3. [Multi-tenancy](02-architecture/03-multi-tenancy.md)
4. [Agentic runtime](02-architecture/04-agentic-runtime.md)
5. [AI abstraction layer](02-architecture/05-ai-abstraction-layer.md)
6. [Workflow engine](02-architecture/06-workflow-engine.md)
7. [VCS adapter](02-architecture/07-vcs-adapter.md)
8. [Deploy adapter](02-architecture/08-deploy-adapter.md)
9. [Data model](02-architecture/09-data-model.md)
10. [API surface](02-architecture/10-api-surface.md)
11. [Security](02-architecture/11-security.md)

### 3 — Infrastructure

**Topology & operations**
1. [Infra overview](03-infrastructure/01-overview.md)
2. [Credit & rate-limit handling](03-infrastructure/03-credit-and-rate-handling.md)
3. [Observability](03-infrastructure/04-observability.md)
4. [Operator runbook](03-infrastructure/05-operator-runbook.md) — application-level failure modes
5. [Self-host runbook](03-infrastructure/16-self-host-runbook.md) — infrastructure-level failure modes
6. [Deploy-target cookbook](03-infrastructure/06-deploy-targets-cookbook.md)
7. [Single-VM deploy via GHCR](03-infrastructure/19-vm-deploy.md)
8. [GitHub App setup](03-infrastructure/20-github-app-setup.md)
9. [Runner workspace images](03-infrastructure/22-runner-images.md) — what the docker SandboxDriver launches per run
10. [Runner network policy](03-infrastructure/23-runner-network-policy.md) — egress allowlist setup for `RUNNER_SANDBOX=docker`

**Stack cookbook** (#569)

- [Node](03-infrastructure/24-stack-node.md)
- [Python](03-infrastructure/25-stack-python.md)
- [Java](03-infrastructure/26-stack-java.md)
- [Go](03-infrastructure/27-stack-go.md)
- [Ruby](03-infrastructure/28-stack-ruby.md)
- [.NET](03-infrastructure/29-stack-dotnet.md)

**Guardrails & budgets**

8. [Monthly spend cap](03-infrastructure/08-monthly-spend-cap.md)
9. [Dry-run mode](03-infrastructure/09-dry-run.md)
10. [Blast-radius limits](03-infrastructure/10-blast-radius.md)
11. [Risk-score gate](03-infrastructure/11-risk-score-gate.md)
12. [Rollback model](03-infrastructure/12-rollback.md)
13. [Spend forecast](03-infrastructure/13-spend-forecast.md)
14. [Anomaly digest](03-infrastructure/14-anomaly-digest.md)
14a. [Pause / resume runs](03-infrastructure/33-pause-resume.md)

**Quality & telemetry**

15. [Evals](03-infrastructure/15-evals.md)
16. [Anonymous usage telemetry](03-infrastructure/07-telemetry.md)
17. [Install telemetry](03-infrastructure/17-install-telemetry.md)

**Advanced**

18. [Multi-agent specialization (planner → coder → reviewer)](03-infrastructure/18-multi-agent.md)

### 4 — Roadmap
- [Vision-tier roadmap](04-roadmap.md). Tactical milestones live in [GitHub Issues](https://github.com/mergecrew/mergecrew/issues) and the [project board](https://github.com/orgs/mergecrew/projects).

## Visuals

- **Diagrams** are embedded inline as [Mermaid](https://mermaid.js.org/) — GitHub
  renders them natively in markdown. See
  [`02-architecture/01-overview.md`](02-architecture/01-overview.md) (component
  map + run sequence), [`02-architecture/04-agentic-runtime.md`](02-architecture/04-agentic-runtime.md)
  (agent loop), and [`03-infrastructure/18-multi-agent.md`](03-infrastructure/18-multi-agent.md)
  (reviewer loop).
- **UI screenshots** live under [`assets/screenshots/`](assets/screenshots/),
  captured by [`scripts/screenshots`](../scripts/screenshots/). Regenerate
  after any UI change with `pnpm screenshots`.

## Conventions

- **Tense.** These docs describe the system as it is, not as it might be. Forward-looking work belongs in the roadmap or in issues.
- **MUST / SHOULD / MAY.** Used in their RFC 2119 sense in normative sections (data model, security, multi-tenancy).
- **Code samples.** TypeScript unless otherwise noted. Database snippets are PostgreSQL.
- **Cross-linking.** When a doc claims "the runner does X", it should link to the file that does it. A broken link signals a stale claim.

## Contributing changes

Substantive product or architectural changes pair the doc edit with the code change in the same PR, plus a one-paragraph rationale in the PR description. Bug fixes don't require doc edits unless they invalidate a documented invariant.
