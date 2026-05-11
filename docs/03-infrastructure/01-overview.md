# Infrastructure overview

How Mergecrew is run today. Mergecrew is open source and self-hosted; there is no opinionated cloud provider. Anything with Postgres + Redis + an S3-compatible blob store and a Node 22 runtime can host it.

## Topology

```
            ┌──────────────────────────────────────────────────────────┐
            │                        Host                              │
            │                                                          │
            │  Node 22 + pnpm 9                                        │
            │                                                          │
            │  ┌────────────┐  ┌──────────────┐  ┌───────────────────┐ │
            │  │ apps/web   │  │ apps/api     │  │ apps/orchestrator │ │
            │  │ Next.js 16 │  │ NestJS HTTP  │  │ BullMQ workers    │ │
            │  │ :3000      │  │ + SSE :4000  │  │                   │ │
            │  └────────────┘  └──────────────┘  └───────────────────┘ │
            │                                                          │
            │  ┌────────────┐  ┌──────────────┐                        │
            │  │apps/runner │  │apps/worker-  │                        │
            │  │ BullMQ     │  │ cron         │                        │
            │  │ consumer   │  │ schedule     │                        │
            │  │            │  │ scanner      │                        │
            │  └────────────┘  └──────────────┘                        │
            └──────────────────────────────────────────────────────────┘
                       │              │              │
                       ▼              ▼              ▼
            ┌──────────────────┐ ┌─────────┐ ┌──────────────────┐
            │ Postgres 16      │ │ Redis 7 │ │ S3-compatible    │
            │ + pgvector + RLS │ │ BullMQ, │ │ blob store       │
            │ :5432            │ │ pubsub  │ │ (artifacts,      │
            │                  │ │ :6379   │ │  transcripts)    │
            └──────────────────┘ └─────────┘ └──────────────────┘

                  External (configured per org)
              ┌───────────────────────────────────────────────────┐
              │ Anthropic / OpenAI / Bedrock / Ollama (BYOK)      │
              │ GitHub App + GitHub Actions                       │
              │ Vercel API (deploy adapter)                       │
              │ Linear / Slack / Email                            │
              └───────────────────────────────────────────────────┘
```

## Local development

The default path for working on Mergecrew is local Docker for stateful services + native Node for the apps. See the root `README.md` for the full step-by-step.

### Stateful services (Docker)

`docker-compose.yml` defines three services:

- `postgres` — `pgvector/pgvector:pg16`, exposed on `:5432`. The init scripts in `infra/sql/init` create the `mergecrew`, `mergecrew_app`, and `mergecrew_migrator` roles, the `mergecrew` database, and the `pgvector`, `uuid-ossp`, and `pgcrypto` extensions.
- `redis` — `redis:7-alpine` on `:6379`. Backs BullMQ queues and the SSE pubsub fanout.
- `localstack` — `localstack/localstack:3` on `:4566`, configured for `s3,kms`. Optional, but it lets you exercise the artifact-write paths without a cloud account.

Bring it all up:

```bash
pnpm compose:up
```

### Apps (native Node)

```bash
pnpm install
pnpm db:migrate
pnpm db:seed
pnpm dev          # api + orchestrator + runner + worker-cron + web in watch mode
```

Default ports: web `:3000`, api `:4000`, postgres `:5432`, redis `:6379`, ollama `:11434` (if installed).

### LLM provider

Out of the box no provider is registered. The zero-cost path is local Ollama:

```bash
brew install ollama
brew services start ollama
ollama pull qwen3:0.6b      # small, supports tool use
```

Hosted providers (Anthropic, OpenAI, Bedrock) work via BYOK — register them through the API per the README. Credentials are envelope-encrypted at rest with `KMS_MASTER_KEY` from `.env`.

## Configuration

Configuration is driven by environment variables (`.env.example` is the source of truth). Categories:

- **Core / DB / Redis.** `DATABASE_URL`, `DATABASE_MIGRATE_URL` (separate role for migrations), `REDIS_URL`.
- **Object storage.** `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, `S3_FORCE_PATH_STYLE` (LocalStack-friendly defaults).
- **Auth.** `MERGECREW_DEV_AUTO_LOGIN` (default `true` outside production), `MERGECREW_DEV_USER_EMAIL`, `BFF_TRUST_TOKEN` (shared header the API uses to trust the BFF on `/v1/auth/exchange`), `JWT_SECRET`, `NEXTAUTH_SECRET`. Optional GitHub / Google OAuth for real sign-in.
- **Integrations.** `GITHUB_APP_*`, `VERCEL_TOKEN`, etc. — empty in dev, filled in for self-hosted deployments that need them.
- **LLM (optional).** `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `OLLAMA_URL`, `BEDROCK_REGION`. These are convenience defaults; per-org BYOK is set through the API.
- **Encryption.** `KMS_MASTER_KEY` (32-byte base64) wraps per-tenant data keys for credential storage.
- **Observability.** `OTEL_EXPORTER_OTLP_ENDPOINT`, `LOG_LEVEL`. Optional.

There are no env-specific code branches; environment shape comes entirely from these variables.

## Self-hosted deployment

Mergecrew has no managed offering. To run it for a team:

- Provision Postgres 16 with the `pgvector`, `uuid-ossp`, and `pgcrypto` extensions enabled. RLS is applied via the migrations and the bootstrap SQL in `infra/sql`.
- Provision Redis 7 (TLS recommended; AUTH on; not internet-exposed).
- Provision an S3-compatible bucket for artifacts/transcripts. Any region works; the runner uses path-style URLs when `S3_FORCE_PATH_STYLE=true`.
- Build and run the four service Dockerfiles in `infra/docker/`:
  - `Dockerfile.api`
  - `Dockerfile.orchestrator`
  - `Dockerfile.runner`
  - `Dockerfile.worker-cron`
  - `Dockerfile.web`
- Inject the env vars listed above. Rotate `JWT_SECRET`, `NEXTAUTH_SECRET`, `KMS_MASTER_KEY`, and `BFF_TRUST_TOKEN` to non-default values before exposing the API publicly.

The api, orchestrator, and worker-cron services are stateless across restarts. The runner holds a per-step git workspace on local disk; size the host's ephemeral storage to fit the largest tenant repo plus a few concurrent steps. `RUNNER_CONCURRENCY` (default `4`) controls how many agent steps a single runner consumes at once.

## Reference deployment (AWS Terraform sketch)

`infra/aws/` contains a starter Terraform sketch documenting a target AWS shape (ECS Fargate + RDS Aurora Postgres + ElastiCache Redis + S3 + KMS + ALB + Route 53). It is **not yet wired up** — see `infra/aws/README.md`. Community contributions to harden it (or to add equivalents for other clouds) are welcome.

## Process model

| Service | Scaling signal | Notes |
|---|---|---|
| `web` | request count | Stateless. Next.js can run on Node or Edge; routes that touch the API need Node. |
| `api` | request count | Stateless. NestJS HTTP + SSE. |
| `orchestrator` | BullMQ depth on `run.due`, `orchestrator.dispatch`, etc. | Stateless across restarts; state lives in Postgres. Multiple replicas are safe — BullMQ guarantees per-job exclusivity. |
| `runner` | BullMQ depth on `runner.step` | Holds the LLM client and per-step git workspace. The only service that needs the BYOK keys decrypted in memory. |
| `worker-cron` | n/a | Tiny scanner; one replica is fine. Polls every `WORKER_CRON_TICK_MS` (default 60s). |

## Observability

- Service logs go to stdout via `pino`; switch the transport with `LOG_LEVEL` and `NODE_ENV` (`pino-pretty` in dev).
- OpenTelemetry exporter is wired through `OTEL_EXPORTER_OTLP_ENDPOINT` when set.
- LangChain callbacks make per-call tracing easy to drop in (e.g., Langfuse) without code changes.
- The `timeline_events` table is the canonical event store; SSE clients consume it in near-real-time via Redis pubsub.
