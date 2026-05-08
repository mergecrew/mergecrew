# Infrastructure overview

How Mergecrew is deployed and operated. V1 targets AWS for backend infrastructure and Vercel for the Next.js frontend, mirroring the user's own SaaS to keep cognitive load low.

## Topology

```
                ┌──────────────────────────────────────────────────────┐
                │                     Vercel                           │
                │   apps/web (Next.js 15, Edge + Node functions)       │
                └──────────────────┬───────────────────────────────────┘
                                   │ HTTPS
                ┌──────────────────▼───────────────────────────────────┐
                │              AWS account: mergecrew-prod                 │
                │                                                      │
                │  ┌──────────────────┐    ┌────────────────────────┐  │
                │  │ ALB (api.mergecrew…) │───▶│ ECS Fargate            │  │
                │  └──────────────────┘    │ services:              │  │
                │                          │  - api (NestJS)        │  │
                │                          │  - orchestrator        │  │
                │                          │  - worker-cron         │  │
                │                          │  - runner-pool         │  │
                │                          └─────────┬──────────────┘  │
                │                                    │                 │
                │  ┌────────────────┐  ┌────────────▼───────┐          │
                │  │ RDS Aurora     │  │ ElastiCache Redis  │          │
                │  │ Postgres v16   │  │ (BullMQ, pubsub)   │          │
                │  └────────────────┘  └─────────────────────┘         │
                │                                                      │
                │  ┌────────────────┐  ┌─────────────────┐             │
                │  │ S3 (artifacts) │  │ KMS (secrets)   │             │
                │  └────────────────┘  └─────────────────┘             │
                │                                                      │
                │  ┌────────────────────────────────────────────────┐  │
                │  │ Observability: CloudWatch, OpenTelemetry to    │  │
                │  │ a managed backend (Honeycomb / Grafana Cloud)  │  │
                │  └────────────────────────────────────────────────┘  │
                └──────────────────────────────────────────────────────┘

                                External
              ┌─────────────────────────────────────────────────────────┐
              │ Anthropic / OpenAI / Bedrock / Ollama (user-supplied)   │
              │ GitHub Actions (user repo's CI)                         │
              │ Vercel API (Mergecrew-managed projects)                     │
              │ Linear / Sentry / Slack APIs                            │
              └─────────────────────────────────────────────────────────┘
```

## Environments

| Env | Purpose | URL | Data |
|---|---|---|---|
| `dev` | Mergecrew engineering's playground; ephemeral | `dev.mergecrew.<domain>` | Synthetic only |
| `staging` | Pre-prod for Mergecrew itself; full pipeline tests | `staging.mergecrew.<domain>` | Synthetic + dogfood org |
| `prod` | Customer-facing | `app.mergecrew.<domain>` | Real tenant data |

Each is its own AWS account (separation of blast radius).

## Compute

### ECS Fargate services

- **api** — Public-facing HTTP/SSE service. ALB-fronted. Autoscale on CPU + req/s. Min 2 tasks for HA.
- **orchestrator** — Internal service. One leader at a time (advisory lock in Postgres + a leader-election service). Standbys present for failover. Stateless across restarts; state lives in Postgres.
- **worker-cron** — Tiny service that scans schedules and emits `RunDueEvent`s. Singleton; missed-tick recovery uses a checkpoint table.
- **runner-pool** — The workhorse. Autoscaled on BullMQ queue depth + per-org concurrency. Each task hosts N runner processes (default 4 concurrent agent steps per task). Tasks are pinned to a placement group with NVMe ephemeral storage for git workspaces.

### Why Fargate

- No EC2 fleet management.
- Per-task IAM roles let us scope runner permissions tightly (only the runner role can decrypt LLM keys).
- Native VPC integration for the egress allowlist.

### Sizing (V1 starting points; revisit at first ten paying tenants)

- `api`: 2 tasks × 1 vCPU / 2 GB.
- `orchestrator`: 2 tasks × 1 vCPU / 2 GB (1 active, 1 standby).
- `worker-cron`: 1 task × 0.25 vCPU / 0.5 GB.
- `runner-pool`: 4–20 tasks × 2 vCPU / 8 GB / 20 GB ephemeral.

## Data layer

### RDS Aurora Postgres

- Version 16.
- Multi-AZ.
- pgvector enabled (Memory store).
- Logical replication slot reserved for future analytics export.
- Connection pooling via PgBouncer (sidecar to API tasks).
- Backups: automated daily, 30-day retention, cross-region snapshot weekly.
- Read replica added in V1.x once load justifies it.

### ElastiCache Redis

- Single primary + replica.
- Used for: BullMQ queues, pubsub for SSE fanout, rate-limit token buckets, ephemeral idempotency keys.
- TLS in transit, AUTH on, no public access.

### S3 buckets

- `mergecrew-prod-artifacts` — transcripts, raw LLM blobs, screenshots, diffs.
- `mergecrew-prod-uploads` — user uploads (avatars, attachments).
- All buckets: versioning on, default encryption with KMS, public access blocked, lifecycle policies as defined in the data model doc.

### KMS

- One CMK per account for application-level encryption.
- Per-data-class data keys for: `llm_keys`, `project_secrets`, `github_app_private_key`, `audit_logs`.
- Key rotation automated.

## Frontend

### Vercel

- `apps/web` deployed on Vercel.
- Edge runtime for read-only, cacheable routes (marketing, signed-out pages).
- Node runtime for authenticated routes and SSE.
- Vercel project linked to the monorepo with a custom build command (`pnpm --filter @mergecrew/web build`).
- Preview deployments on every PR.

### Why Vercel for our own UI

- Same toolchain we recommend to greenfield customers (eat-your-own-dogfood).
- Best-in-class Next.js performance.
- We do not host customer-uploaded code there; their dev deploys go to their pipeline.

## Networking

- VPC: `10.0.0.0/16`, three AZs, public subnets for ALB only, private subnets for everything else.
- Egress: NAT Gateway per AZ.
- Egress allowlist enforced at NAT via a managed prefix list of approved destinations + DNS-based hold-down for runner-only egress.
- Internal mTLS between `api` ⇄ `orchestrator` ⇄ `runner-pool`.

## DNS

- Route 53 for `mergecrew.<domain>` zones.
- ACM certificates for HTTPS.
- `app.mergecrew.<domain>` → Vercel (CNAME).
- `api.mergecrew.<domain>` → ALB.

## CI/CD for Mergecrew itself

The dogfood loop: Mergecrew engineering uses Mergecrew to ship Mergecrew. The bootstrap CI/CD (used until Mergecrew can ship Mergecrew):

- GitHub Actions builds and tests on every PR.
- On merge to `main`: builds Docker images, pushes to ECR, runs Aurora migrations, deploys ECS services with rolling update.
- Vercel auto-deploys `apps/web` on `main`.
- Preview deployments on PRs (Vercel for web; staging-namespaced ECS deploy for backend on demand).

Once Mergecrew dogfoods itself, agents propose changes; the same GitHub Actions workflow handles deploys; Mergecrew's own production-promote gate is the human approval.

## Configuration

- Static config in code where it doesn't change per env (provider catalog defaults, skill catalog).
- Per-env config in AWS Parameter Store / Secrets Manager.
- No env-specific code branches; all env-specific behavior is config-driven.

## Cost ceiling (initial)

For V1, monthly infra cost target excluding LLM tokens:

- Compute (Fargate): ~$300
- RDS + replica: ~$300
- Redis: ~$80
- S3 + transfer: ~$30
- Vercel: ~$60
- Observability: ~$100

Total ~$870 / month at V1 launch. Scales sub-linearly with tenant count up to the first dozen orgs.
