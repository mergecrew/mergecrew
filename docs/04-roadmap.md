# Roadmap

Mergecrew is built around a small set of durable themes. Tactical milestone work — individual issues, exit criteria, sequencing — lives in [GitHub Issues](https://github.com/mergecrew/mergecrew/issues) and the [project board](https://github.com/orgs/mergecrew/projects). This file documents the *direction*, not the backlog.

## Themes

### V0 — Foundation
The skeleton: monorepo, identity, the LLM abstraction, a skill SDK, the agent loop, and the first VCS + deploy adapters. Nothing user-facing; everything plumbed.

### V1 — Product
The full lifecycle, multi-tenant. Scheduled daily runs, tenancy + RLS, project setup wizard, the orchestrator, runner pool with workspace isolation, real-time UI, the changeset → PR → dev-deploy flow, digest + promote/rollback, bug-triage agent, hosted + local LLM providers. The exit bar is Mergecrew dogfooding Mergecrew for two unsupervised weeks.

### V1.x — Post-launch hardening
MFA, per-org budgets with a hard stop, cost dashboard, more tracker integrations, vision input, scheduled-run calendars, SOC 2 Type 2 prep.

### V2 — Broader fit
Visual lifecycle editor, more deploy adapters (AWS-direct, Fly.io, Render, Railway), more VCS adapters (GitLab, Gitea, GHE), public TypeScript + Python SDKs and outbound webhooks, multi-repo projects, optional managed-LLM tier, auto-promote allowlists for low-risk change classes.

### V3 — Enterprise
SAML / SCIM, customer-managed keys, dedicated VPC tier, self-hosted runner (control plane stays SaaS), audit-log streaming to customer SIEMs, HIPAA-ready controls, on-call response automation, a marketplace of community-contributed agents and skills.

## Engineering principles

These are durable. They constrain how we sequence work, not which work to do.

- **No skipping V0.** Reliability is built on the abstractions in V0; rushing them produces fragility paid for in V1.x.
- **Dogfood gates each milestone.** No V1 milestone is "done" until it's used by Mergecrew engineering on Mergecrew itself.
- **The production-promote gate is a fixed product law.** From V1.0 onward, *who* approves is configurable; *whether* is not.
- **Public API after the contract is stable.** V1 keeps the API internal; V2 publishes after months of internal exercise.
- **No premature horizontal scale work.** Single-region until tenant load demonstrates the need.

## Where the granular work lives

- [Open issues](https://github.com/mergecrew/mergecrew/issues) — every claimable task
- [Project board](https://github.com/orgs/mergecrew/projects) — what's in flight
- [Discussions](https://github.com/mergecrew/mergecrew/discussions) — design proposals before they become issues
