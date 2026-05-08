# API surface

The Mergecrew API is a NestJS HTTP service at `apps/api`, fronted by the Next.js BFF for browser traffic. The same API serves machine-to-machine calls (V2 public API) once we expose it.

## Conventions

- REST over HTTPS, JSON.
- Versioning: URL prefix `/v1`. Public V2 API will be `/v1` as well (we cut a `/v2` only on breaking changes).
- All resources scoped under `/orgs/:org_slug/...`.
- All requests require auth (session cookie or `Authorization: Bearer <token>`).
- All responses include a `X-Mergecrew-Request-Id` header.
- Errors use a normalized shape:

```json
{
  "error": {
    "code": "GATE_REQUIRED",
    "message": "Production promotion requires approval.",
    "details": { "requiredRole": "operator" }
  }
}
```

## Auth

| Endpoint | Method | Purpose |
|---|---|---|
| `/v1/auth/session` | GET | Current session info (user, orgs, current org). |
| `/v1/auth/logout` | POST | Invalidate session. |
| `/v1/auth/oauth/github/start` | GET | Begin GitHub OAuth (sign-in). |
| `/v1/auth/oauth/github/callback` | GET | OAuth callback. |
| `/v1/auth/oauth/google/start` | GET | … |
| `/v1/auth/oauth/google/callback` | GET | … |

GitHub *App* installation uses a separate flow:

| Endpoint | Method | Purpose |
|---|---|---|
| `/v1/integrations/github/install` | GET | Redirects to GitHub App install. |
| `/v1/integrations/github/callback` | GET | Receives `installation_id`. |

## Organizations

| Endpoint | Method | Purpose |
|---|---|---|
| `/v1/orgs` | GET / POST | List user's orgs / create new org. |
| `/v1/orgs/:slug` | GET / PATCH / DELETE | Org detail / update / soft-delete. |
| `/v1/orgs/:slug/members` | GET / POST | List members / invite. |
| `/v1/orgs/:slug/members/:user_id` | PATCH / DELETE | Change role / remove. |
| `/v1/orgs/:slug/audit-log` | GET | Paged audit entries. |

## Projects

| Endpoint | Method | Purpose |
|---|---|---|
| `/v1/orgs/:slug/projects` | GET / POST | List / create project. |
| `/v1/orgs/:slug/projects/:project_slug` | GET / PATCH / DELETE | Detail / update / soft-delete. |
| `/v1/orgs/:slug/projects/:project_slug/inception` | POST | Re-run Project Inception. |
| `/v1/orgs/:slug/projects/:project_slug/secrets` | GET / POST / DELETE | List/create/delete project secrets. |
| `/v1/orgs/:slug/projects/:project_slug/deploy-targets` | GET / POST | List / configure deploy targets. |
| `/v1/orgs/:slug/projects/:project_slug/deploy-targets/:id` | PATCH / DELETE | Update / delete. |
| `/v1/orgs/:slug/projects/:project_slug/lifecycle` | GET | Current parsed lifecycle. |
| `/v1/orgs/:slug/projects/:project_slug/lifecycle/versions` | GET | Versioned history. |
| `/v1/orgs/:slug/projects/:project_slug/agents` | GET | Resolved agent roster. |
| `/v1/orgs/:slug/projects/:project_slug/agents/:agent_id` | GET / PATCH | Override per-agent settings (model, fallback). |
| `/v1/orgs/:slug/projects/:project_slug/skills` | GET | Resolved skill catalog for this project. |

## Runs

| Endpoint | Method | Purpose |
|---|---|---|
| `/v1/orgs/:slug/projects/:project_slug/runs` | GET / POST | List runs / start "Run now". |
| `/v1/orgs/:slug/projects/:project_slug/runs/:run_id` | GET | Run detail. |
| `/v1/orgs/:slug/projects/:project_slug/runs/:run_id/cancel` | POST | Cancel. |
| `/v1/orgs/:slug/projects/:project_slug/runs/:run_id/timeline` | GET | Paged timeline (replay). |
| `/v1/orgs/:slug/projects/:project_slug/runs/:run_id/timeline/stream` | GET (SSE) | Live timeline stream. |
| `/v1/orgs/:slug/projects/:project_slug/runs/:run_id/transcript/:step_id` | GET | Replayable transcript. |
| `/v1/orgs/:slug/projects/:project_slug/schedule` | GET / PATCH | Project's run schedule. |

### SSE timeline stream

```
GET /v1/orgs/:slug/projects/:project_slug/runs/:run_id/timeline/stream
Accept: text/event-stream
```

Events:

```
event: timeline
data: {"id":"...","type":"AGENT_STEP_STARTED","payload":{...},"occurredAt":"..."}

event: timeline
data: {"type":"AGENT_TOOL_CALL", ... }

event: heartbeat
data: {"now":"..."}
```

Reconnect protocol: client sends `Last-Event-ID` (the largest event id received). Server replays from that id then continues live.

## Changesets

| Endpoint | Method | Purpose |
|---|---|---|
| `/v1/orgs/:slug/projects/:project_slug/changesets` | GET | List. Filters: `status`, `daily_run_id`. |
| `/v1/orgs/:slug/projects/:project_slug/changesets/:cs_id` | GET | Detail. |
| `/v1/orgs/:slug/projects/:project_slug/changesets/:cs_id/diff` | GET | Full diff (or signed URL to blob). |
| `/v1/orgs/:slug/projects/:project_slug/changesets/:cs_id/screenshots` | GET | Before/after URLs. |
| `/v1/orgs/:slug/projects/:project_slug/changesets/:cs_id/decisions` | POST | Promote / rollback / defer. |
| `/v1/orgs/:slug/projects/:project_slug/digest/:date` | GET | The digest payload for a date. |
| `/v1/orgs/:slug/projects/:project_slug/digest/:date/group-promote` | POST | Atomic group promote. |

`POST /decisions` body:

```json
{ "kind": "promote", "comment": "looks good" }
```

## Approvals

| Endpoint | Method | Purpose |
|---|---|---|
| `/v1/orgs/:slug/inbox` | GET | Pending approvals + flagged changesets across all projects. |
| `/v1/orgs/:slug/projects/:project_slug/approvals` | GET | Pending approvals for a project. |
| `/v1/orgs/:slug/projects/:project_slug/approvals/:approval_id` | GET | Detail. |
| `/v1/orgs/:slug/projects/:project_slug/approvals/:approval_id/resolve` | POST | Approve / reject / takeover. |
| `/v1/orgs/:slug/projects/:project_slug/intent-inbox` | GET / POST | List / submit intents. |

## LLM configuration

| Endpoint | Method | Purpose |
|---|---|---|
| `/v1/orgs/:slug/llm/providers` | GET / POST | List / register provider (incl. BYOK key upload). |
| `/v1/orgs/:slug/llm/providers/:id` | PATCH / DELETE | Update / remove. |
| `/v1/orgs/:slug/llm/profiles` | GET / POST | List / create profile. |
| `/v1/orgs/:slug/llm/profiles/:id` | PATCH / DELETE | Update / remove. |
| `/v1/orgs/:slug/llm/probe` | POST | Live capability probe for a provider config. |

## Costs

| Endpoint | Method | Purpose |
|---|---|---|
| `/v1/orgs/:slug/costs` | GET | Org cost summary by day. |
| `/v1/orgs/:slug/projects/:project_slug/costs` | GET | Per-project breakdown. |
| `/v1/orgs/:slug/projects/:project_slug/runs/:run_id/costs` | GET | Per-run breakdown. |

## Webhooks (inbound)

| Endpoint | Method | Purpose |
|---|---|---|
| `/v1/webhooks/github` | POST | GitHub webhook receiver. |
| `/v1/webhooks/sentry` | POST | Sentry alert receiver. |
| `/v1/webhooks/linear` | POST | Linear webhook receiver. |
| `/v1/webhooks/slack/interactivity` | POST | Slack action button responses. |

All inbound webhooks verify signatures and dispatch events into the orchestrator's inbox.

## Webhooks (outbound, V2)

`/v1/orgs/:slug/webhooks` registers user-supplied URLs for events like `changeset.opened`, `changeset.deployed_dev`, `changeset.promoted`, `run.completed`. Signed with per-org HMAC.

## Pagination & filtering

- All list endpoints accept `limit` (default 50, max 200) and `cursor` (opaque).
- Cursors are stable across pages.
- All list endpoints support `?sort=` with allowlisted sort keys per resource.
- Filters use query params; complex filter combinations use `?filter=<base64-json>` (V2).

## Rate limiting

Per session: 600 req/min default. Per BYOK token (V2): user-configurable with a per-org floor.

## Idempotency

Mutating endpoints accept `Idempotency-Key`. The API stores the key + request hash → response for 24h. A retried request with the same key returns the recorded response.

## Errors

Error codes (non-exhaustive):

- `UNAUTHORIZED`, `FORBIDDEN`
- `NOT_FOUND`
- `VALIDATION_FAILED` (with `details.fields`)
- `GATE_REQUIRED` — action blocked by a gate.
- `BUDGET_EXHAUSTED`
- `RATE_LIMITED` — Mergecrew's own rate limit.
- `PROVIDER_UNAVAILABLE`
- `ADAPTER_AUTH_INVALID`
- `IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD`

## SDKs

- V1: TypeScript SDK auto-generated from the OpenAPI spec, used by both the Next.js app and any internal tooling.
- V2: Public TS + Python SDK.

## OpenAPI

The API exposes its spec at `/v1/openapi.json`. Generated from NestJS controllers with `@nestjs/swagger`. Used by the SDK generator and the docs site.
