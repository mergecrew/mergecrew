import client, { type Histogram, type Counter, type Gauge } from 'prom-client';

// Single process-wide registry. `collectDefaultMetrics` wires the standard
// node + process metrics (event loop lag, RSS, heap, GC, etc.) so operators
// have something to point Grafana at without any per-service work.
//
// Metric naming follows the Prometheus convention: snake_case, `_total` suffix
// for counters, base unit at the tail (seconds for durations). The `service`
// label is set once at process boot so a single Prometheus job can scrape
// every Mergecrew service and split them in PromQL with `{service="api"}`.

export const registry = new client.Registry();

let started = false;

export function initMetrics(opts: { service: string; defaultLabels?: Record<string, string> }): void {
  if (started) return;
  started = true;
  registry.setDefaultLabels({ service: opts.service, ...(opts.defaultLabels ?? {}) });
  client.collectDefaultMetrics({ register: registry });
}

export const httpRequestsTotal: Counter<string> = new client.Counter({
  name: 'mergecrew_http_requests_total',
  help: 'Total HTTP requests handled by the API, labelled by method, route, and status family.',
  labelNames: ['method', 'route', 'status'],
  registers: [registry],
});

export const httpRequestDurationSeconds: Histogram<string> = new client.Histogram({
  name: 'mergecrew_http_request_duration_seconds',
  help: 'HTTP request handler latency in seconds.',
  labelNames: ['method', 'route', 'status'],
  // Buckets sized for a typical NestJS API: most requests are sub-100ms,
  // the long tail goes up to a few seconds (webhook fanouts, batch reads).
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [registry],
});

export const queueDepthGauge: Gauge<string> = new client.Gauge({
  name: 'mergecrew_queue_depth',
  help: 'BullMQ queue depth split by state (waiting / active / delayed / failed).',
  labelNames: ['queue', 'state'],
  registers: [registry],
});

export const orchestratorTickAgeSeconds: Gauge<string> = new client.Gauge({
  name: 'mergecrew_orchestrator_tick_age_seconds',
  help: 'Seconds since the last successful heartbeat-sweeper tick (orchestrator only).',
  registers: [registry],
});

export async function exposition(): Promise<{ body: string; contentType: string }> {
  return { body: await registry.metrics(), contentType: registry.contentType };
}
