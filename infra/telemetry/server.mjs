#!/usr/bin/env node
// Reference telemetry receiver for Mergecrew (#253). Operators wanting
// to see what their install emits run this on the same VM and point
// `MERGECREW_TELEMETRY_URL` at it.
//
// One job: accept POST /v1/events with a JSON array body and append each
// event as one JSON line to `events.jsonl`. No queues, no auth, no
// retries — telemetry is best-effort. If you want guarantees, sit a
// real ingestion pipeline behind this.
//
// Usage:
//   node infra/telemetry/server.mjs
//   PORT=9090 TELEMETRY_OUT=/var/log/mergecrew-telemetry.jsonl \
//     node infra/telemetry/server.mjs
//
// Why this file is sub-50 LOC: the privacy invariants live in the
// emitter, not the receiver. Operators should be able to audit this
// entire script in 30 seconds.

import { createServer } from 'node:http';
import { appendFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const PORT = Number(process.env.PORT ?? 9095);
const OUT = resolve(process.env.TELEMETRY_OUT ?? './events.jsonl');

const server = createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/healthz') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok' }));
    return;
  }
  if (req.method !== 'POST' || req.url !== '/v1/events') {
    res.writeHead(404).end();
    return;
  }
  let body = '';
  for await (const chunk of req) body += chunk;
  let batch;
  try {
    batch = JSON.parse(body);
    if (!Array.isArray(batch)) throw new Error('expected array');
  } catch (err) {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: String(err.message ?? err) }));
    return;
  }
  const lines = batch.map((ev) => JSON.stringify(ev) + '\n').join('');
  try {
    await appendFile(OUT, lines, 'utf8');
  } catch (err) {
    console.error(`[telemetry-receiver] append failed: ${err.message ?? err}`);
    res.writeHead(500).end();
    return;
  }
  res.writeHead(204).end();
});

server.listen(PORT, () => {
  console.log(`[telemetry-receiver] listening on :${PORT} → ${OUT}`);
});
