# Mergecrew — specification

> Working codename: **Mergecrew**. An autonomous product team in a box: it specifies, designs, builds, deploys, tests, and triages bugs on a SaaS codebase every day, and asks the human only at the moments where judgment is required.

This directory is the full V1 specification: product, design, architecture, infrastructure, roadmap. Read in order for first-time orientation; deeper docs are cross-linked.

## At a glance

- **Stack.** NestJS (`api`, `runner`, `orchestrator`) + Next.js (`web`) in a TypeScript monorepo, on AWS Fargate + Aurora Postgres + Redis + S3, with Vercel for the web tier.
- **Audience.** Multi-tenant SaaS from day one; dogfooded by us first.
- **Code surface.** Tenants connect their own GitHub repo; agents open real PRs in real repos.
- **Deploy surface.** Pluggable adapter; ships with **GitHub Actions** (the bridge to existing AWS pipelines) and **Vercel** (opinionated default for greenfield).
- **LLM surface.** Provider-agnostic — Anthropic, OpenAI/Codex, AWS Bedrock, Ollama. Capability-routed per agent, per skill.
- **Loop.** Runs unattended for a full day; pauses on provider rate limits and human gates; resumes on its own.
- **Promotion model.** Production deploys never happen without an explicit human decision.

## Reading order

### 0 — Product
1. [Vision](00-product/01-vision.md)
2. [Scope (V1 in/out)](00-product/02-scope.md)
3. [Personas](00-product/03-personas.md)
4. [User journeys](00-product/04-user-journeys.md)
5. [Feature breakdown](00-product/05-features.md)
6. [Success metrics](00-product/06-success-metrics.md)

### 1 — Design
1. [Design principles](01-design/01-principles.md)
2. [Information architecture](01-design/02-information-architecture.md)
3. [Key screens (with ASCII wireframes)](01-design/03-key-screens.md)
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
1. [Infra overview](03-infrastructure/01-overview.md)
2. [Environments](03-infrastructure/02-environments.md)
3. [Credit & rate-limit handling](03-infrastructure/03-credit-and-rate-handling.md)
4. [Observability](03-infrastructure/04-observability.md)
5. [Disaster recovery](03-infrastructure/05-disaster-recovery.md)

### 4 — Roadmap
- [Phased roadmap (V0 → V3)](04-roadmap.md)

## Conventions used in this spec

- **Codenames.** "Mergecrew" is the working name for the platform. Replace globally if branding decides otherwise.
- **Tense.** "We" = the Mergecrew team. "The user" = the tenant's persona (Theo, Mira, Riley).
- **MUST / SHOULD / MAY.** Used in their RFC 2119 sense in normative sections (data model invariants, security, multi-tenancy).
- **Examples.** ASCII wireframes are illustrative. Final pixel-level designs live in Figma.
- **Code samples.** TypeScript-flavored pseudocode unless otherwise noted. Database snippets are PostgreSQL.

## Boundaries — what this spec does NOT cover

- Pixel-level visual design and Figma source.
- Marketing site copy.
- Pricing & billing pages (TBD; V1 ships free with BYOK).
- Customer support tooling.
- Internal HR / hiring playbooks.
- Detailed runbooks (live in the engineering repo under `docs/runbooks/`).

## How this spec evolves

- Treat this directory as living documentation, versioned in the same repo as the product.
- Significant changes go through a small RFC process: open a PR with the doc edit + a 1-page rationale; require ≥ 1 reviewer.
- Versioning by milestone: tag the docs at each V0/V1/etc. cut.

## Open questions tracked in V1 planning

These are deliberately deferred and will be resolved during V1 implementation:

1. Custom durable engine vs Temporal — revisited at end of V1.3.
2. Embedding model default — OpenAI `text-embedding-3-small` vs an open alternative.
3. Whether to ship a CLI in V1 (helpful for power users; cost is small but non-zero).
4. Pricing model for V2 (BYOK-only forever vs tiered managed-LLM).
5. Whether the production-promote hard gate ever softens (proposed: never; revisit after 1 year of data).
