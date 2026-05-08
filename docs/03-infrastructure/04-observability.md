# Observability

What we measure, where it goes, and how we use it.

## Three-tier model

1. **Metrics.** Time-series for trends and alerting (latency, throughput, error rate, queue depth, cost).
2. **Logs.** Structured records of discrete events (requests, decisions, failures).
3. **Traces.** Cross-service request paths (BFF → API → Orchestrator → Runner → Provider).

All three are emitted via OpenTelemetry from every Mergecrew process. The collector runs as a sidecar on each ECS task, batches, and forwards to a managed backend (V1: Honeycomb or Grafana Cloud — pick one, not both).

## Metrics

### Service-level

- `http.server.requests{route, status}` — req/s and latency.
- `http.server.duration` — histogram by route.
- `sse.connections.active{run_id}` — active SSE clients.
- `db.query.duration{op}` — Postgres query latency by tag.
- `redis.command.duration{op}`.
- `process.cpu`, `process.memory`.

### Run engine

- `runs.started.count{project_id}`.
- `runs.completed.count{project_id, outcome}` (`done`/`failed`/`cancelled`).
- `runs.duration{project_id}`.
- `runs.paused.duration{kind}` (rate-limit / gate / budget).
- `dispatch.queue.depth`.
- `agent_step.duration{agent_kind}`.
- `agent_step.attempts{agent_kind}`.
- `tool_call.duration{skill}` and `tool_call.errors{skill}`.

### LLM

- `llm.calls{provider, model, outcome}`.
- `llm.latency{provider, model}` (histogram).
- `llm.tokens.input{provider, model}` and `.output`.
- `llm.cache_hit_rate{provider, model}` (Anthropic).
- `llm.cost_usd{provider, model}` rolled up to `org_id`.
- `llm.rate_limit_hits{provider}`.

### Adapters

- `vcs.calls{op, outcome}`.
- `deploy.triggers{adapter, outcome}`.
- `deploy.duration{adapter, target}`.

### Business / product

- `changesets.opened.count{project_id}`.
- `changesets.promoted.count{project_id}`.
- `changesets.rolled_back_from_prod.count{project_id}`.
- `digest.opened.count{platform}` (mobile / desktop / slack).
- `decision.latency_seconds{decision}`.

## Logs

Every log line is JSON with a stable schema:

```json
{
  "ts": "2026-05-08T14:32:11.041Z",
  "level": "info",
  "service": "runner",
  "trace_id": "0af7651916cd43dd8448eb211c80319c",
  "span_id": "b7ad6b7169203331",
  "org_id": "org_...",
  "project_id": "prj_...",
  "run_id": "run_...",
  "step_id": "step_...",
  "msg": "agent_step.completed",
  "agent_kind": "BackendEngineer",
  "duration_ms": 1240,
  "tokens_in": 12030,
  "tokens_out": 802,
  "usd": 0.18
}
```

- No raw prompts in logs (logs reference object-storage blob URLs for raw payloads).
- No secrets in logs (central scrubber).
- Log level: `info` default; `debug` only in dev/staging.
- Sampled at 100% in V1; samplers added if volume becomes a problem.

## Traces

Every external request and queue dispatch is a span:

- `http.request` (root span on the BFF).
- `api.request`.
- `orchestrator.dispatch`.
- `runner.agent_step`.
- `runner.tool_call.<skill>`.
- `llm.chat.<provider>.<model>`.
- `vcs.<op>`.
- `deploy.<adapter>.<op>`.

Trace context is propagated through:
- HTTP headers (`traceparent`).
- BullMQ job metadata.
- The orchestrator's inbox events.

## Dashboards (V1 set)

1. **Platform health.** API p50/p95/p99, error rate, DB latency, Redis latency, queue depth.
2. **Run health.** Runs in flight, runs paused, average run duration, success rate.
3. **LLM cost & latency.** Per-provider, per-model.
4. **Per-tenant cost.** Top orgs by today's spend.
5. **Changeset funnel.** opened → tested → deployed → awaiting → promoted/rolled-back.
6. **Adapter health.** GitHub API errors, Vercel deploy failures, GitHub Actions deploy timing.
7. **Real-time stream health.** SSE connections, drop rate.

## Alerts (V1 set)

| Condition | Severity | Channel |
|---|---|---|
| API 5xx > 1% over 5m | page | PagerDuty |
| Orchestrator no leader > 2m | page | PagerDuty |
| BullMQ queue depth > 5000 for 5m | page | PagerDuty |
| Postgres replication lag > 30s | warn | Slack |
| Cross-tenant access denied event > 0 | page | PagerDuty |
| Decryption failures > 10/min | page | PagerDuty (security) |
| Specific provider error rate > 50% for 10m | warn | Slack |
| Per-org daily spend > 10× median | warn | Slack |
| SSE drop rate > 10% for 10m | warn | Slack |
| Smoke-test failures in CI > 0 | page | Slack |

## Per-tenant observability surfaces

What the tenant sees in-product:

- Cost dashboard (per project, per agent, per provider).
- Run health rollup (success rate, average duration, last-7-day trend).
- Provider health from the tenant's perspective (their key's recent error rate).
- An exportable JSON of their last 30 days of LlmInvocation rows (V1.x).

## Audit observability

Audit events are logged via the same pipeline but with stricter retention and a "do not delete" policy. Tenants with compliance requirements can:

- Export audit log to S3 (V1.x).
- Stream audit log to a customer-managed sink (V2).

## Synthetic monitoring

- Heartbeat checks every minute against `api.mergecrew.<domain>/healthz`.
- A scheduled "synthetic project" runs daily on the staging environment, exercising the full pipeline (sign in → connect repo → run → digest → promote). Failures page on-call.

## Sampling, retention, costs

- Metrics: 13-month retention, 1-minute resolution downsampled to 5m at 90 days.
- Logs: 30 days hot, 1 year cold (S3 + Athena).
- Traces: 100% sampled in V1; if backend cost becomes excessive, head-based 10% with always-keep on errors.
- Audit: per the org's policy.

## What we deliberately don't do in V1

- Custom RUM (real user monitoring) on the web app — Vercel Analytics is enough.
- Server-side session replay.
- Per-skill custom dashboards (skill authors get the standard `tool_call` metrics).
- Anomaly detection ML.
