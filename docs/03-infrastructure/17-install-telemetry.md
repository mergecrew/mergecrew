# Anonymous install telemetry

Mergecrew can send a single daily anonymous ping describing the **shape** of your install. The point is to give the project a signal on adoption — stars are vanity, installs are reality — without ever identifying any specific operator.

**Default: OFF.** A fresh install never makes an outbound call. You must explicitly opt in through the Settings UI or by setting `Organization.telemetryEnabled = true` for at least one org.

This page is distinct from [`07-telemetry.md`](07-telemetry.md), which documents the *operator-side* telemetry transport used for in-app analytics. Install telemetry rides the same plumbing but emits one specific event type (`install.ping`) from worker-cron once per UTC day.

## What gets sent

When at least one org has opted in, worker-cron emits **one** JSON payload per UTC day to `MERGECREW_TELEMETRY_URL`:

```json
{
  "type": "install.ping",
  "installId": "f6b8e9a4-0c1d-4f72-9c0a-3e1d8b2a5f6e",
  "occurredAt": "2026-05-12T04:00:00.123Z",
  "version": "0.1.0",
  "deployKind": "compose",
  "orgCount": 3,
  "projectCount": 7,
  "evalsEnabledOrgCount": 1
}
```

| Field | What it means |
|---|---|
| `installId` | Stable per-install random UUID. Generated lazily on first opt-in (reuses the existing `Organization.telemetryInstallId`). Not linked to the operator's identity in any way. |
| `version` | Mergecrew version string from the root `package.json`. |
| `deployKind` | Best-effort heuristic from worker-cron's env: `kubernetes` if `KUBERNETES_SERVICE_HOST` is set, `compose` if `COMPOSE_PROJECT_NAME` is set, otherwise `unknown`. |
| `orgCount` | Total non-deleted orgs in the install. |
| `projectCount` | Total non-deleted projects across all orgs. |
| `evalsEnabledOrgCount` | Number of orgs with `evalsEnabled = true`. Helps the project measure feature uptake. |

## What is NEVER sent

- Org slugs, names, or descriptions
- Project slugs, names, or repo URLs
- User emails, names, or IDs
- API keys, JWT secrets, or any credential material
- LLM provider kinds or model names
- IP addresses (the receiving endpoint logs no IPs)
- Costs, run counts, or any per-project metric

The full set of fields the `install.ping` event is **type-allowed** to carry lives in [`packages/telemetry/src/events.ts`](../../packages/telemetry/src/events.ts). Adding a field requires a PR that touches both the schema and this doc — so any change to what's collected is auditable in git.

## How to opt in / opt out

### Via the web UI

Settings → Anonymous install telemetry → Toggle. The card shows the last-pinged timestamp and a button to preview the next payload before consenting.

### Via SQL

```sql
-- Opt in (any org enabling it activates install ping for the whole install)
update organizations set telemetry_enabled = true where slug = 'demo';

-- Opt out
update organizations set telemetry_enabled = false where slug = 'demo';
```

When **every** org is opted out, the install ping silently stops emitting on the next worker-cron tick.

## Preview what would be sent

Before opting in, you can see the exact payload that the next ping would carry. From the repo root:

```sh
pnpm telemetry:preview
```

Output when not opted in:

```
telemetry:preview: no org has opted in (default). No ping is scheduled.
To opt in: Settings → Anonymous install telemetry → Enable.
```

Output when opted in but `MERGECREW_TELEMETRY_URL` is unset:

```
Endpoint: (none — NoopTransport active; nothing sent over the wire)
Payload (next scheduled ping):
{
  "installId": "...",
  ...
}
```

The script never makes a network call — it builds the payload locally and prints it.

## Where to find it in the code

| File | What it does |
|---|---|
| [`packages/telemetry/src/events.ts`](../../packages/telemetry/src/events.ts) | Type-level allow-list. New fields here are visible in git diff. |
| [`apps/worker-cron/src/install-ping-tick.ts`](../../apps/worker-cron/src/install-ping-tick.ts) | The actual tick. Reads opted-in orgs, builds the payload, dispatches via the existing `TelemetryEmitter`. |
| [`scripts/telemetry-preview.ts`](../../scripts/telemetry-preview.ts) | The `pnpm telemetry:preview` command. |
| [`packages/telemetry/src/http-transport.ts`](../../packages/telemetry/src/http-transport.ts) | HTTP transport. Off when `MERGECREW_TELEMETRY_URL` is unset — `NoopTransport` is the default. |

## Where the data goes

Right now: **nowhere by default.** The project has not stood up a public receiver yet. The `MERGECREW_TELEMETRY_URL` is a hook waiting for a deploy.

When/if the project stands up a receiver, this page will be updated with:
- The receiver's hostname
- Whether IP logging is disabled (it will be)
- How long pings are retained
- Whether the aggregate data is published openly (the goal is yes)

## Related

- [Telemetry transport](07-telemetry.md) — operator-side analytics events (org_created, project_created, etc.)
- [Anomaly digest](14-anomaly-digest.md) — local-only digest signal, not telemetry
