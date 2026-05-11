# Observability

Mergecrew exposes liveness/readiness checks and Prometheus metrics on every long-running service so operators can wire them into their existing tooling without per-deploy code. The endpoints are unauthenticated by design — they're scraped by infrastructure, not users — and live at root paths to keep them out of the `/v1/*` auth middleware.

## Endpoints

| Service | Port | `/healthz` | `/metrics` |
| --- | --- | --- | --- |
| `apps/api` | `4000` (shared with the API) | DB + Redis ping | per-route HTTP histogram + queue depths + default node metrics |
| `apps/orchestrator` | `9090` (separate, see `ORCHESTRATOR_METRICS_PORT`) | Redis ping + heartbeat-sweeper tick age | queue depths + sweeper tick age + default node metrics |

### `/healthz` shape

Returns 200 with `{"status":"ok","checks":{...}}` when every check passes. Returns 503 with `{"status":"degraded","checks":{...},"details":{...}}` when any fails. Probes can read the HTTP status alone; the body is for humans grepping logs.

### `/metrics` shape

Standard Prometheus text-format exposition (`text/plain; version=0.0.4`). Every Mergecrew-emitted metric is prefixed with `mergecrew_`; default node metrics (event loop lag, RSS, GC, process CPU) come straight from `prom-client` and follow its naming.

## Metrics emitted by Mergecrew

| Name | Type | Labels | Notes |
| --- | --- | --- | --- |
| `mergecrew_http_requests_total` | counter | `method`, `route`, `status` (`2xx`, `4xx`, …) | API only. `route` is the matched NestJS route pattern (or a normalized path if no match), so cardinality stays bounded even on long-lived deployments. |
| `mergecrew_http_request_duration_seconds` | histogram | same as above | API only. Buckets from 5ms to 10s. |
| `mergecrew_queue_depth` | gauge | `queue`, `state` (`waiting`, `active`, `delayed`, `failed`) | API + orchestrator. Sampled lazily on each `/metrics` scrape so there's no separate background tick. |
| `mergecrew_orchestrator_tick_age_seconds` | gauge | — | Orchestrator only. Seconds since the heartbeat sweeper last completed a tick. `/healthz` flips to 503 when this exceeds `4 × ORCHESTRATOR_HEARTBEAT_SWEEPER_INTERVAL_MS`. |

Every series carries a `service="api"` or `service="orchestrator"` label so a single Prometheus scrape job can hit both and split them in PromQL.

## Wiring it up

### Prometheus

Minimal scrape config — one job per service so the `service` label is implicit:

```yaml
scrape_configs:
  - job_name: mergecrew-api
    static_configs:
      - targets: ['api:4000']
    metrics_path: /metrics
  - job_name: mergecrew-orchestrator
    static_configs:
      - targets: ['orchestrator:9090']
    metrics_path: /metrics
```

### Kubernetes probes

```yaml
livenessProbe:
  httpGet: { path: /healthz, port: 4000 }   # 9090 for orchestrator
  periodSeconds: 30
  failureThreshold: 3
readinessProbe:
  httpGet: { path: /healthz, port: 4000 }
  periodSeconds: 10
  failureThreshold: 2
```

### Useful PromQL

```promql
# API p95 latency by route
histogram_quantile(0.95, sum by (le, route) (rate(mergecrew_http_request_duration_seconds_bucket{service="api"}[5m])))

# Steps that aren't being picked up by any runner
mergecrew_queue_depth{queue="runner.step", state="waiting"} > 0

# Orchestrator sweeper falling behind
mergecrew_orchestrator_tick_age_seconds > 60
```

## What's deliberately not here

- **Traces.** OpenTelemetry export is a follow-up — metrics first, traces once we know what's worth tracing.
- **A first-party Grafana dashboard.** The metric *shapes* above are the contract. Community-contributed dashboards live in `dashboards/` once enough of them accumulate to justify the directory.
