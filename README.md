# Mergecrew

> Autonomous product team in a box: every day, `mergecrew` specifies, designs, builds, deploys to dev, scans for bugs, and hands you a digest to approve before anything reaches production.

[![status: alpha](https://img.shields.io/badge/status-alpha-orange.svg)](#status)
[![license: Apache 2.0](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE)
[![docs](https://img.shields.io/badge/docs-spec-green.svg)](docs/README.md)

Mergecrew is the open-source platform for running an **agentic software development lifecycle** — multi-agent product teams that operate on a daily cadence against your real repo, deploy automatically to your dev environment, and require an explicit human approval before anything ships to prod.

---

## Why Mergecrew exists

The autonomous-coding category has converged on the *agent layer*: Devin, Cursor's cloud agents, GitHub Copilot's coding agent, OpenHands, SWE-agent. They all do roughly the same thing — take a ticket, open a PR. None of them own the *loop* around that work.

**Mergecrew is the loop.**

- **Scheduled, not triggered.** Runs on a cron against your real repo. No tickets required.
- **Full lifecycle, not just code.** Spec → design → build → deploy-to-dev → bug scan → digest → human approval → prod.
- **Multi-tenant by design.** One workspace per org, tenant-isolated Postgres (RLS), per-org budgets, per-org provider keys. Self-host privately or run as a service.
- **Human-gated production.** Promotion to prod is always a human decision. Non-configurable invariant.
- **Pluggable agents and providers.** Anthropic, OpenAI, AWS Bedrock, or local Ollama. The bundled NestJS+LangGraph runner ships by default; OpenHands / Claude Code / your own runner can be wired in.

## How Mergecrew compares

| Project | Triggered by | Lifecycle scope | Multi-tenant | Prod gate | License |
|---|---|---|---|---|---|
| **Mergecrew** | scheduled (cron) | spec → deploy → digest | yes | mandatory | Apache 2.0 |
| [OpenHands](https://github.com/All-Hands-AI/OpenHands) | task / chat | code only | yes (Cloud) | optional | MIT |
| [Aeon](https://github.com/aaronjmars/aeon) | scheduled (cron) | code only | no | none ("no babysitting") | MIT |
| [SWE-agent](https://github.com/SWE-agent/SWE-agent) | issue | code only | no | n/a | MIT |
| [MetaGPT](https://github.com/FoundationAgents/MetaGPT) / [GPT Pilot](https://github.com/Pythagora-io/gpt-pilot) | one-shot prompt | greenfield only | no | n/a | MIT |
| Devin / Cursor / Copilot agent | task / chat | code only | no | optional | proprietary |

The combination of *scheduled lifecycle + multi-tenant + mandatory prod gate* is currently whitespace. Detailed positioning is in [docs/00-product/02-scope.md](docs/00-product/02-scope.md).

## Architecture in one paragraph

Mergecrew is a pnpm-workspace monorepo. Four NestJS services (`api`, `orchestrator`, `runner`, `worker-cron`) plus a Next.js web app share a Postgres database with row-level security, a Redis instance for BullMQ queues, and an S3-compatible blob store for artifacts. Agents run as [LangGraph](https://github.com/langchain-ai/langgraphjs) state graphs over a pluggable LLM router. Deploy and VCS are behind adapter interfaces — GitHub Actions and Vercel ship by default. The full spec lives in [`docs/`](docs/README.md).

## Status

**Alpha.** The user-facing surfaces (org/project setup, run timeline, digest, approval) are wired end-to-end and run locally against Ollama with no API keys. APIs are not stable; the database schema may change without a migration path between alpha versions. Not yet recommended for production tenants.

---

## Stack

- **Backend.** NestJS 10 across four services: `api`, `orchestrator`, `runner`, `worker-cron`.
- **Frontend.** Next.js 15 (App Router), shadcn/ui, Tailwind.
- **Data.** Postgres 16 (pgvector + RLS) and Redis (BullMQ + pubsub).
- **Agent runtime.** [LangGraph.js](https://github.com/langchain-ai/langgraphjs) graph + [LangChain.js](https://github.com/langchain-ai/langchainjs) provider integrations (Anthropic, OpenAI, AWS Bedrock, Ollama).
- **Tooling.** pnpm workspaces, Turbo, TypeScript, Prisma.

## Layout

```
apps/
  api/                 NestJS HTTP + SSE                (port 4000)
  orchestrator/        Durable run engine (BullMQ)
  runner/              Agent step executor
  worker-cron/         Schedule scanner
  web/                 Next.js app                       (port 3000)
packages/
  domain/              Zod-shaped domain types
  llm/                 LangChain provider factory + capability router
  skills/              Skill SDK + ~25 stock skills
  agent-runtime/       LangGraph StateGraph (agent + tools nodes)
  adapters-vcs/        GitHub
  adapters-deploy/     GitHub Actions, Vercel
  adapters-tracker/    Linear, GitHub Issues
  adapters-comms/      Slack, Email
  config-yaml/         mergecrew.yaml parser
  db/                  Prisma schema, migrations, RLS
  eventlog/            Timeline events
infra/
  sql/                 RLS + bootstrap
  docker/              Service Dockerfiles
docs/                  Spec set (read this first)
```

---

## Quick start

Two paths, pick whichever fits. New here? Pair either path with the
[**mergecrew-sample-app**](https://github.com/mergecrew/mergecrew-sample-app)
— a tiny Next.js app with one deliberate bug, designed to be connected to a
fresh Mergecrew install so you can watch the full agent loop fix it and ship
a Vercel preview, without touching your own codebase.

### One command (trial, all-in-Docker)

If you just want to **see Mergecrew running**, the fastest path is the bundled compose stack — Postgres, Redis, API, orchestrator, runner, worker-cron, and web all start together. Migrations apply on boot and a `demo` org + user are seeded so the web UI is usable immediately.

```bash
git clone https://github.com/mergecrew/mergecrew.git
cd mergecrew
pnpm compose:full     # or: docker compose -f docker-compose.full.yml up
```

Open <http://localhost:3000>. Auto-login signs you in as `demo@mergecrew.local`. Add an LLM provider in the org settings to start triggering runs. Stop with `pnpm compose:full:down`; wipe state with `docker compose -f docker-compose.full.yml down -v`.

This path uses dev-mode defaults (zero JWT secret, no OAuth, no TLS) and is for local trials only. Production self-host uses `docker-compose.prod.yml` — see [docs/03-infrastructure](docs/03-infrastructure).

### Hacking on the code (recommended for contributors)

You'll be running everything locally with **Docker for Postgres/Redis**, **Homebrew Ollama for a local LLM**, and **Node + pnpm for the apps**. No paid services are required, no OAuth setup is required to log in.

### 1. Prereqs

| Tool | Purpose | Install |
|---|---|---|
| Node 22+ (LTS) | runtime | `nvm install --lts && nvm alias default lts/*` |
| pnpm 9+ | package manager | `npm install -g pnpm@9.12.0` |
| Docker | Postgres + Redis | Docker Desktop |
| Homebrew | macOS package manager (used for Ollama) | https://brew.sh |
| Ollama (optional but recommended) | local LLM, no API keys | `brew install ollama` |

The repo's `package.json` pins `pnpm@9.12.0` via `packageManager`, so Corepack will use that exact version automatically.

### 2. Clone and install

```bash
git clone https://github.com/mergecrew/mergecrew.git
cd mergecrew
cp .env.example .env
pnpm install
```

The default `.env` works out of the box for local dev. **Auto-login is enabled by default** (`MERGECREW_DEV_AUTO_LOGIN=true`), so you do not need to set up GitHub or Google OAuth to use the app — you'll be signed in as a built-in demo user.

### 3. Start Postgres + Redis (Docker)

```bash
pnpm compose:up
```

This brings up `mergecrew-postgres` (pgvector/pg16) on `:5432` and `mergecrew-redis` on `:6379`. The Postgres init script creates the `mergecrew`, `mergecrew_app`, and `mergecrew_migrator` roles, the `mergecrew` database, and the `pgvector` / `uuid-ossp` / `pgcrypto` extensions.

To stop: `pnpm compose:down`. To wipe: `docker compose down -v`.

### 4. Apply migrations and seed

```bash
pnpm db:migrate
pnpm db:seed
```

The seed creates:
- Organization `demo` (slug)
- User `demo@mergecrew.local` with role `owner`
- Project `acme` with a default lifecycle (`mergecrew.yaml`) and ~8 agents

> The `pnpm db:*` and `pnpm dev` scripts auto-load `.env` via `dotenv-cli`. If you invoke `prisma` directly outside pnpm, prefix with `pnpm exec dotenv -e .env -- prisma …` so the connection URLs are visible.

### 5. Start a local LLM (Ollama)

You can skip this if you intend to use a hosted provider (Anthropic, OpenAI, Bedrock). For the zero-cost path:

```bash
brew services start ollama
ollama pull qwen3:0.6b      # ~520MB, supports tool use
```

Verify Ollama is up:

```bash
curl http://localhost:11434/api/tags
```

### 6. Run the app

For development with hot reload across all four backend services + the web app:

```bash
pnpm dev
```

This runs `tsx watch` against `api`, `orchestrator`, `runner`, `worker-cron`, plus `next dev` for `web`, all in parallel.

For a production-equivalent local run:

```bash
pnpm -r build
pnpm --filter @mergecrew/api start          &
pnpm --filter @mergecrew/orchestrator start &
pnpm --filter @mergecrew/runner start       &
pnpm --filter @mergecrew/web start          &
```

### 7. Open the app

Browse to <http://localhost:3000>. You'll land directly on **Demo Org** — no sign-in required.

### 8. Register the LLM provider and trigger a run

Out of the box, no LLM provider is registered for the demo org — you have to point Mergecrew at one. The fastest path is the local Ollama provider:

```bash
USER_ID=$(PGPASSWORD=mergecrew psql -h localhost -U mergecrew -d mergecrew -tA -c \
  "select id from users where email='demo@mergecrew.local';")
H="x-mergecrew-user-id: $USER_ID"

# 1. Register the Ollama provider
PID=$(curl -sS -X POST http://localhost:4000/v1/orgs/demo/llm/providers \
  -H "$H" -H 'content-type: application/json' \
  -d '{"kind":"ollama","label":"Local Ollama","endpoint":"http://localhost:11434",
       "capabilityOverrides":{"models":["qwen3:0.6b"]}}' | jq -r .id)

# 2. Default profile that prefers qwen3:0.6b
curl -sS -X POST http://localhost:4000/v1/orgs/demo/llm/profiles \
  -H "$H" -H 'content-type: application/json' \
  -d "{\"name\":\"local\",\"preferenceOrder\":[\"$PID/qwen3:0.6b\"],\"capabilityRouting\":{}}"

# 3. Trigger a daily run
curl -sS -X POST http://localhost:4000/v1/orgs/demo/projects/acme/runs -H "$H" -d '{}'
```

The run takes ~50 seconds on Ollama qwen3:0.6b. Watch it progress at <http://localhost:3000/orgs/demo/projects/acme/timeline>.

To inspect run state directly:

```bash
psql "postgresql://mergecrew:mergecrew@localhost:5432/mergecrew" -c \
  "select agent_kind, status, total_input_tokens, total_output_tokens
   from agent_steps order by started_at desc limit 8;"
```

---

## Environments and ports

| Service | URL | Notes |
|---|---|---|
| Web | <http://localhost:3000> | Next.js |
| API | <http://localhost:4000> | NestJS HTTP + SSE |
| OpenAPI | <http://localhost:4000/v1/openapi.json> | |
| Postgres | localhost:5432 | user `mergecrew` / pw `mergecrew` / db `mergecrew` |
| Redis | localhost:6379 | |
| Ollama | localhost:11434 | only if installed |

Logs are streamed to `.logs/{api,orchestrator,runner,web}.log` if you started the services in the background.

## Authentication

### Default: dev auto-login

The web app is signed in as **`demo@mergecrew.local`** automatically. This is controlled by:

```env
MERGECREW_DEV_AUTO_LOGIN=true            # default in non-production
MERGECREW_DEV_USER_EMAIL=demo@mergecrew.local
MERGECREW_DEV_USER_NAME=Demo User
BFF_TRUST_TOKEN=dev-trust-token        # the API trusts the web BFF when this matches
```

When `NODE_ENV=production`, auto-login defaults to off. Set `MERGECREW_DEV_AUTO_LOGIN=false` explicitly to disable it in dev too.

The API also accepts an `x-mergecrew-user-id` header for programmatic access (used by the curl examples above) — also a dev-only convenience.

### Optional: GitHub / Google OAuth

If you want real OAuth in your local environment:

1. Set `MERGECREW_DEV_AUTO_LOGIN=false` in `.env`.
2. Create OAuth apps:
   - GitHub: <https://github.com/settings/developers> — callback `http://localhost:3000/api/auth/callback/github`
   - Google: <https://console.cloud.google.com/apis/credentials> — callback `http://localhost:3000/api/auth/callback/google`
3. Fill `GITHUB_OAUTH_CLIENT_ID` / `GITHUB_OAUTH_CLIENT_SECRET` (and/or Google equivalents) in `.env`.
4. Restart the web app.

## Switching to a hosted LLM (Anthropic / OpenAI / Bedrock)

The provider abstraction routes through LangChain's official integrations, so no custom code is required to switch:

```bash
# Anthropic example — needs ANTHROPIC_API_KEY in .env first
PID=$(curl -sS -X POST http://localhost:4000/v1/orgs/demo/llm/providers \
  -H "$H" -H 'content-type: application/json' \
  -d '{"kind":"anthropic","label":"Anthropic","apiKey":"'"$ANTHROPIC_API_KEY"'",
       "capabilityOverrides":{"models":["claude-sonnet-4-6"]}}' | jq -r .id)

curl -sS -X POST http://localhost:4000/v1/orgs/demo/llm/profiles \
  -H "$H" -H 'content-type: application/json' \
  -d "{\"name\":\"anthropic\",\"preferenceOrder\":[\"$PID/claude-sonnet-4-6\"],\"capabilityRouting\":{}}"
```

Credentials are envelope-encrypted at rest using `KMS_MASTER_KEY` from `.env`.

## Common scripts

| Command | What it does |
|---|---|
| `pnpm install` | install all workspaces |
| `pnpm compose:up` / `pnpm compose:down` | Postgres + Redis (Docker) |
| `pnpm db:migrate` | apply migrations |
| `pnpm db:seed` | seed demo org + project |
| `pnpm db:reset` | drop + recreate + migrate + seed |
| `pnpm dev` | run all services in watch mode |
| `pnpm build` | build all packages and apps |
| `pnpm typecheck` | typecheck across the workspace |
| `pnpm test` | run tests |

## Troubleshooting

- **Web shows "create your first organization"** — the seed didn't run (or ran against a different DB). `pnpm db:seed`.
- **API returns `org not found`** — your `x-mergecrew-user-id` doesn't match the seeded user. Look it up:
  `psql "$DATABASE_URL" -c "select id, email from users;"`
- **Run fails with `no provider available`** — register an LLM provider for the org (step 8 above).
- **Ollama model not found** — `ollama pull qwen3:0.6b`.
- **`prisma migrate deploy` complains about `DATABASE_MIGRATE_URL`** — you ran Prisma directly. Use `pnpm db:migrate` (which auto-loads `.env`), or prefix with `pnpm exec dotenv -e .env -- prisma migrate deploy`.
- **Port 5432 / 6379 already in use** — you have a local Postgres/Redis already running. Either stop it or change the port mapping in `docker-compose.yml`.

---

## Why this stack

- **LangChain.js + LangGraph.js** for the agent loop — battle-tested OSS, handles provider drift, gives you a graph the team already knows.
- **BullMQ + Postgres** for the workflow layer — durable queues survive restarts and pause-on-rate-limit; LangGraph isn't designed to replace this.
- **NestJS + Next.js** because most TS engineers can read both immediately, lowering the contributor ramp-up.
- **No paid runtime dependencies.** Observability hooks are open ([Langfuse](https://langfuse.com) drops in via LangChain callbacks) but not required.

## Contributing

Mergecrew is built in the open and accepts contributions. See [CONTRIBUTING.md](CONTRIBUTING.md) for the dev setup and PR flow. Start with the [`docs/`](docs/README.md) tree to understand the architecture and product invariants, then check [open issues](https://github.com/mergecrew/mergecrew/issues) for `good first issue` or `roadmap`. PRs that change agent behavior, multi-tenant isolation, or the human approval gate require a design note in the PR description and ideally a [Discussion](https://github.com/mergecrew/mergecrew/discussions) first.

By participating you agree to the [Code of Conduct](CODE_OF_CONDUCT.md). Security issues should be reported privately per [SECURITY.md](SECURITY.md).

## Sponsors

Mergecrew runs autonomous LLM workflows daily; even alpha-stage dogfooding burns real money in API credits. The project is looking for backers — Anthropic / OpenAI / Bedrock credits, hosting credits, or recurring sponsorship via GitHub Sponsors. See [SPONSORS.md](SPONSORS.md) for what's needed and how to back the project.

> **Looking for the first sponsor.** Token-credit and cash sponsors are acknowledged in `SPONSORS.md`, in release notes, and on this README.

## License

[Apache 2.0](LICENSE).
