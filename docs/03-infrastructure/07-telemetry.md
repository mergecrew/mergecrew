# Anonymous-usage telemetry

Mergecrew supports an **opt-in, off-by-default** stream of anonymous usage events. This page documents exactly which events exist, what fields they carry, and what's not collected — so an operator can audit before opting in.

> **Status (V2.y #253).** The package, the org-level opt-in toggle, and this schema doc are landed. **No outbound transport is wired yet** — opting in records the preference and generates a per-install id but emits to a stub that only buffers in memory. The follow-up PR wires actual event emission at the listed surfaces and ships a receiving backend.

## Invariants

These are enforced by the type system in [`packages/telemetry/src/events.ts`](../../packages/telemetry/src/events.ts) — adding any field outside this list requires a PR that updates this doc.

- **Off by default.** Even on `docker-compose.full.yml`. No telemetry leaves the box unless an org admin explicitly opts in under Settings → Anonymous usage telemetry.
- **No identifiers.** No org slug, project slug, user email, user id, or IP. Each event carries one `installId` — a per-org random UUID generated on first opt-in and stored in `organizations.telemetry_install_id`. That UUID never leaves that row except as the event identifier; toggling telemetry off retains it so a later re-opt-in stays under the same id (lets the receiver de-duplicate flap without us recording anything else).
- **No content.** No repo names, no PR titles, no agent outputs, no LLM prompts/responses, no error traces.
- **Documented schema.** Every emit point is a typed call against the union in [`events.ts`](../../packages/telemetry/src/events.ts); adding a new event type or field is a compile-time change visible in code review.
- **Never fails the hot path.** The emitter wraps every transport call in a try/catch and returns `void` on failure. Mergecrew functions identically whether the telemetry endpoint is reachable or not.

## Events

Every event carries these base fields:

| Field | Type | Notes |
|---|---|---|
| `type` | string | The discriminant — one of the values listed below. |
| `installId` | uuid | The org's per-install random UUID. |
| `occurredAt` | ISO 8601 | When the event was generated locally. |
| `version` | string | Mergecrew version from root `package.json`. |

### `org.created`

Emitted once when a new organization is created. No additional fields. Lets us count adoption.

### `project.created`

| Field | Type | Notes |
|---|---|---|
| `paused` | boolean | Whether the new project finished with both a connected repo and a dev deploy target, or stayed paused per V2.x #229. |

Lets us measure onboarding completion rate without knowing which projects.

### `integration.connected`

| Field | Type | Notes |
|---|---|---|
| `provider` | enum | One of: `github`, `gitlab`, `gitea`, `github-actions`, `vercel`, `netlify`, `aws-direct`, `fly`, `render`, `railway`, `linear`, `github-issues`, `sentry`. |

The provider kind only — never the credentials, the org/project slug, the repo, or any other identifier.

### `run.completed`

| Field | Type | Notes |
|---|---|---|
| `status` | enum | One of: `done`, `failed`, `cancelled`. Mirrors `daily_run_status` minus the non-terminal paused states. |

### `wizard.bailed`

| Field | Type | Notes |
|---|---|---|
| `step` | enum | One of: `create-project`, `connect-repo`, `deploy-target`, `tracker`. |

Helps us see where the onboarding flow loses people without recording who left.

## What's explicitly not collected

- No org / project slug or name.
- No user email, name, or auth provider.
- No IP address (events POST through the same outbound HTTP path as everything else; the receiver does not record the source IP).
- No repo URLs, branch names, PR titles, commit SHAs, or file paths.
- No LLM model ids, prompts, outputs, or token counts.
- No deploy target config (only the adapter `provider` enum on `integration.connected`).
- No timing on individual steps. Run-level outcome only.
- No errors, stack traces, or log lines.

## Where to look in the code

- Schema (and the only place new event types are defined): [`packages/telemetry/src/events.ts`](../../packages/telemetry/src/events.ts)
- Emitter with the privacy short-circuit: [`packages/telemetry/src/emitter.ts`](../../packages/telemetry/src/emitter.ts)
- Buffer/no-op transports: [`packages/telemetry/src/transport.ts`](../../packages/telemetry/src/transport.ts)
- Org opt-in column: `organizations.telemetry_enabled` / `telemetry_install_id` ([`schema.prisma`](../../packages/db/prisma/schema.prisma))
- API endpoints: `GET / PATCH /v1/orgs/:slug/telemetry` ([`apps/api/src/modules/org/org.controller.ts`](../../apps/api/src/modules/org/org.controller.ts))
- UI: Settings → Anonymous usage telemetry ([`apps/web/src/app/orgs/[slug]/(org)/settings/page.tsx`](../../apps/web/src/app/orgs/[slug]/(org)/settings/page.tsx))

## What's still ahead

- Real outbound transport. PR 2 of #253 wires an HTTP transport once the receiving backend is chosen (likely a Cloudflare Worker writing to a flat file).
- Hook the existing service-layer call sites (`OrgService.create`, `ProjectService.create`, deploy-target upsert, `OrchestratorService.completeRun`, wizard exit) to call `emitter.emit(...)`.
- A live audit panel on the settings page that surfaces the last N events the buffer has seen since the page loaded.
