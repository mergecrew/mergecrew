# Architecture overview

## Component map

```
┌──────────────────────────────────────────────────────────────────────┐
│                              Browser (Next.js)                       │
│  Pages · Server Components · SSE client · React Query · shadcn/ui    │
└─────────────────┬────────────────────────────────────────────────────┘
                  │ HTTPS (REST + SSE)
┌─────────────────▼────────────────────────────────────────────────────┐
│                         BFF: Next.js Route Handlers                  │
│      Auth (NextAuth) · per-org session · SSR data fetching           │
└─────────────────┬────────────────────────────────────────────────────┘
                  │ internal mTLS / network ACL
┌─────────────────▼────────────────────────────────────────────────────┐
│                    Mergecrew API (NestJS, multi-tenant)                  │
│   Modules: Auth · Org · Project · Lifecycle · Run · Approval ·       │
│            Changeset · Timeline · Cost · Integration · LLM           │
└──┬───────────┬───────────────┬──────────────┬─────────────┬──────────┘
   │           │               │              │             │
   │           │               │              │             │
   ▼           ▼               ▼              ▼             ▼
┌──────┐  ┌─────────┐  ┌──────────────┐  ┌────────┐  ┌────────────┐
│Postg │  │ Redis   │  │  Object      │  │ Vector │  │ Outbound   │
│res   │  │ (queue, │  │  store       │  │ store  │  │ webhooks   │
│(RLS) │  │ pubsub, │  │ (artifacts,  │  │(memory │  │ (Slack,    │
│      │  │ rate    │  │  screenshots,│  │ embed) │  │ email,     │
│      │  │ buckets)│  │  transcripts)│  │        │  │ analytics) │
└──────┘  └─────────┘  └──────────────┘  └────────┘  └────────────┘

   ▲                                                  ▲
   │                                                  │
   │              ┌────────────────────────────┐      │
   └──────────────│  Orchestrator (Temporal or  ├──────┘
                  │  custom durable engine on   │
                  │  BullMQ + Postgres)         │
                  └─────────┬───────────────────┘
                            │ schedules + dispatches
                            ▼
                  ┌────────────────────────────┐
                  │   Runner pool (Mergecrew      │
                  │   Workers, NestJS apps     │
                  │   on autoscale)            │
                  │                            │
                  │   Each runner hosts:       │
                  │   - Agent runtime          │
                  │   - Skill executor sandbox │
                  │   - LLM provider clients   │
                  │   - Git workspace          │
                  └─────────┬──────────────────┘
                            │ tool calls (network)
                            ▼
                  ┌────────────────────────────┐
                  │   External providers:      │
                  │   - Anthropic API          │
                  │   - OpenAI API             │
                  │   - AWS Bedrock            │
                  │   - Ollama (HTTP)          │
                  │   - GitHub API             │
                  │   - GitHub Actions         │
                  │   - Vercel API             │
                  │   - Linear, Sentry, Slack  │
                  └────────────────────────────┘
```

## Layering

Mergecrew is a layered system. Each layer has a single responsibility and one well-defined interface to the layer below.

| Layer | Concern | Implementation |
|---|---|---|
| **UI** | rendering, input, real-time view | Next.js |
| **BFF** | session, per-org guarding, SSR data, SSE proxy | Next.js route handlers |
| **API** | tenant-aware CRUD, business rules, gate evaluation, cost tracking | NestJS modules |
| **Orchestration** | durable run scheduling, retries, rate-limit pause/resume, idempotency | Temporal *or* a custom engine on BullMQ + Postgres |
| **Runner** | actually execute agents and skills inside a sandboxed workspace | NestJS worker app |
| **Agent runtime** | the loop: prompt → model → tool call → observation → … | Common abstraction; for Anthropic the Claude Agent SDK is used as a reference implementation |
| **LLM abstraction** | provider-agnostic chat / tools / embeddings | Internal NestJS module (`LlmModule`) |
| **Skill abstraction** | side-effecting capabilities the agent can invoke | Internal NestJS module (`SkillsModule`) |
| **Adapter layer** | VCS, deploy, tracker, comms | Internal NestJS modules per integration |

Layers above can call layers below. Below cannot call above (events bubble up via the event log; not synchronous).

## Repository layout (monorepo)

```
mergecrew/
  apps/
    web/                  Next.js 15 (App Router)
    api/                  NestJS (HTTP + websocket)
    runner/               NestJS worker (consumes orchestrator dispatch)
    orchestrator/         Temporal worker OR custom durable engine
  packages/
    domain/               TypeScript domain types & zod schemas
    llm/                  LLM provider abstraction + impls
    skills/               Skill catalog + skill SDK
    adapters-vcs/         GitHubProvider impl
    adapters-deploy/      GitHubActionsProvider, VercelProvider
    adapters-tracker/     LinearProvider, GitHubIssuesProvider
    adapters-comms/       SlackProvider, EmailProvider
    db/                   Prisma schema + migrations
    eventlog/             Append-only timeline event types & repository
    agent-runtime/        Provider-agnostic agent loop
    config-yaml/          mergecrew.yaml parser/validator
  infra/
    aws/                  Terraform / CDK
    docker/               Dockerfiles for api, runner, orchestrator, web
```

## Process model

In production, Mergecrew runs as separate process types so they can scale independently:

- `web` — stateless, autoscales on request count.
- `api` — stateless, autoscales on request count.
- `orchestrator` — singletonish (Temporal cluster, or custom leader-elected). Coordinates schedules.
- `runner` — autoscales on queue depth. Each runner can hold N concurrent agent steps. The runner is the *only* process that holds an LLM client and a per-run git workspace.
- `worker-cron` — small scheduler that fires per-project DailyRun events at the configured times.

## Data flow: a run, end to end

1. `worker-cron` triggers a DailyRun for a project at the scheduled time.
2. `orchestrator` instantiates a durable workflow, persists its initial state, and dispatches the first agent step to a `runner` via the queue.
3. `runner` claims the step, sets up the git workspace (clones the repo, checks out a branch), and executes the agent loop:
   - Builds the prompt from the agent definition + the step's input.
   - Calls the LLM through `LlmModule`.
   - For each tool call the model produces, runs it through `SkillsModule` (which talks to adapters or the workspace).
   - Streams events to the `eventlog` (which writes to Postgres and pubsubs to Redis).
4. On step completion, the runner reports back to the orchestrator with the output.
5. Orchestrator persists the new state, evaluates which step(s) come next, dispatches them.
6. SSE clients subscribed to the run receive events from Redis pubsub.
7. On rate-limit (429) or quota error from the LLM:
   - The runner returns a `RATE_LIMITED` outcome with `retry_after`.
   - The orchestrator records `RUN_PAUSED_RATE_LIMIT` and schedules a wake-up timer.
   - At wake-up, the same step is dispatched again.
8. When a workflow reaches a `require-approval` gate, orchestrator emits `GATE_REACHED`, dispatches an approval-request creation, and stops dispatching this branch until `HUMAN_APPROVED` arrives.
9. When all changesets reach the deploy stage, the day's digest is assembled.

## Why Temporal (or an equivalent)

The orchestrator must be **durable** because:

- Runs span hours.
- Process restarts must not lose state.
- Rate-limit pauses can be 30+ minutes.
- Human gates can be days.

Temporal models all of this natively (workflows, activities, signals, timers). The alternative is a hand-rolled state machine on top of Postgres + BullMQ. Both work. V1 picks **a custom durable engine on BullMQ + Postgres** to avoid the operational footprint of running Temporal in V1; V2 reconsiders if the custom engine starts feeling like we're building Temporal poorly. (See `docs/02-architecture/06-workflow-engine.md`.)

## Why NestJS

- The user already runs NestJS in production.
- Module boundaries map well to the layering above (one Nest module per concern).
- Built-in DI suits adapter-pattern code (LLM providers, VCS adapters, deploy adapters).
- Worker apps reuse the same domain code as the API by sharing packages.

## Why Next.js (App Router)

- Server Components fit the "data-heavy view" surfaces (timeline, digest).
- Route handlers serve as a tidy BFF, so the browser never talks to NestJS directly.
- SSE has a clean implementation in route handlers.
- Mobile-first rendering performance is reasonable on Vercel's edge runtime for read paths.

## Cross-cutting concerns

- **Tenancy**: every record carries `organization_id`. Postgres RLS enforces isolation. NestJS request context carries the org from the session/JWT and sets the connection's `app.org_id` GUC. See `docs/02-architecture/03-multi-tenancy.md`.
- **Auth**: NextAuth on the BFF; service-to-service via short-lived signed JWTs.
- **Secrets**: provider keys live in Postgres encrypted with KMS-derived data keys; never logged; never returned in API responses.
- **Cost ledger**: every model call writes a `LlmInvocation` row with input/output tokens and price. Aggregation happens off the hot path.
- **Eventlog**: append-only `timeline_events` table, partitioned by month, with a per-run materialized view for quick reads.
