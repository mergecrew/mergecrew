# Telemetry reference receiver

A tiny HTTP server that accepts the Mergecrew telemetry stream and appends each event as one JSON line to a file. **Operators who want analytics from their own install run this themselves on the same VM** — Mergecrew does not host a hosted receiver and the default config never phones home.

## Why this exists

`@mergecrew/telemetry` defaults to `NoopTransport`. Operators who *do* want signal need somewhere to send events to. The minimal "somewhere" is a few lines of `node:http` that appends to a file — that's what this is. Drop a real analytics stack (Loki, Plausible, ClickHouse, …) behind it later if you outgrow the JSONL file.

## Run it

```bash
# Defaults: :9095, ./events.jsonl
node infra/telemetry/server.mjs

# Override the port or the output path
PORT=9095 TELEMETRY_OUT=/var/log/mergecrew-telemetry.jsonl \
  node infra/telemetry/server.mjs
```

Point Mergecrew at it by setting `MERGECREW_TELEMETRY_URL` on the API and orchestrator processes:

```
MERGECREW_TELEMETRY_URL=http://localhost:9095/v1/events
```

## API

| Method | Path | Body | Response |
|---|---|---|---|
| `GET` | `/healthz` | — | `{ status: "ok" }` |
| `POST` | `/v1/events` | JSON array of [TelemetryEvent](../../packages/telemetry/src/events.ts) | 204 No Content on success, 400 on malformed body, 500 on write failure |

That's the entire contract. No auth — the receiver is meant to listen on a private interface (loopback or VPC-internal). No retries — telemetry is best-effort.

## Reading the output

`events.jsonl` is one event per line. Each line is exactly the [`TelemetryEvent`](../../packages/telemetry/src/events.ts) shape — `installId`, `occurredAt`, `version`, `type`, plus per-type fields. Tools like `jq` work as-is:

```bash
# how many runs completed today, by status
jq -r 'select(.type=="run.completed") | .status' events.jsonl | sort | uniq -c

# which deploy adapter got picked most often
jq -r 'select(.type=="integration.connected") | .provider' events.jsonl | sort | uniq -c
```

## What's not in this script

- **No queue.** A burst over a long disk write will drop events.
- **No batching.** Each POST is one `appendFile` call.
- **No auth.** Bind to a private interface or run a reverse proxy in front.
- **No rotation.** Set up `logrotate` if the file grows unbounded.

For a production-grade ingest pipeline, treat this as the reference contract, not the runtime.
