/**
 * Outbound webhook delivery must refuse internal destinations before
 * connecting, must not follow redirects, and must record only generic
 * error text in the delivery log.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import pino from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const deliveries: Array<Record<string, unknown>> = [];
let webhookUrl = '';

vi.mock('@mergecrew/db', () => ({
  withTenant: async (_org: string, fn: (tx: unknown) => unknown) =>
    fn({
      outboundWebhook: {
        findFirst: async () => ({ id: 'wh1', enabled: true, url: webhookUrl, secret: 's3cret' }),
        update: async () => ({}),
      },
      webhookDelivery: {
        create: async ({ data }: { data: Record<string, unknown> }) => {
          deliveries.push(data);
          return data;
        },
      },
    }),
}));

const { DELIVERY_ERRORS, deliverOutboundWebhook, postWebhook } = await import('../src/outbound-webhook-worker.js');

const logger = pino({ level: 'silent' });
const job = { webhookId: 'wh1', organizationId: 'org1', eventType: 'run.completed', body: { ok: true } };
const deny = { allowPrivate: false, allowPrivateHosts: [] as string[] };

let server: http.Server;
let port: number;
let hits = 0;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    hits += 1;
    if (req.url === '/redirect') {
      res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' });
      res.end();
      return;
    }
    if (req.url === '/fail') {
      res.writeHead(500, { 'content-type': 'text/plain' });
      res.end('internal secret details');
      return;
    }
    res.writeHead(204);
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

beforeEach(() => {
  deliveries.length = 0;
  hits = 0;
});

describe('outbound webhook delivery', () => {
  it.each([
    'http://redis:6379/',
    'http://api:4000/hook',
    'http://127.0.0.1/',
    'http://localhost:4000/',
    'http://10.0.0.1/',
    'http://172.17.0.1:5432/',
    'http://[::1]/',
    'http://[::ffff:127.0.0.1]/',
    'http://169.254.169.254/latest/meta-data/',
    'http://100.64.0.1/',
  ])('refuses %s and records a generic error', async (url) => {
    webhookUrl = url;
    const resolver = async () => [{ address: '172.18.0.3', family: 4 as const }];
    await expect(
      deliverOutboundWebhook(job, logger, 1, { egress: { ...deny, resolver } }),
    ).rejects.toThrow(/webhook delivery failed/);
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]).toMatchObject({ statusCode: null, errorMessage: DELIVERY_ERRORS.blocked });
    expect(hits).toBe(0);
  });

  it('does not follow redirects', async () => {
    const r = await postWebhook(`http://hooks.test:${port}/redirect`, {}, '{}', {
      egress: { allowPrivate: false, allowPrivateHosts: ['hooks.test'], resolver: async () => [{ address: '127.0.0.1', family: 4 }] },
    });
    expect(r).toMatchObject({ statusCode: 302, errorMessage: DELIVERY_ERRORS.redirect });
    expect(hits).toBe(1);
  });

  it('records the status but never the upstream body for non-2xx', async () => {
    const r = await postWebhook(`http://hooks.test:${port}/fail`, {}, '{}', {
      egress: { allowPrivate: false, allowPrivateHosts: ['hooks.test'], resolver: async () => [{ address: '127.0.0.1', family: 4 }] },
    });
    expect(r.statusCode).toBe(500);
    expect(r.errorMessage).toBe('non-2xx: 500');
    expect(JSON.stringify(r)).not.toContain('secret');
  });

  it('delivers to an allowed destination', async () => {
    webhookUrl = `http://hooks.test:${port}/ok`;
    await deliverOutboundWebhook(job, logger, 1, {
      egress: { allowPrivate: false, allowPrivateHosts: ['hooks.test'], resolver: async () => [{ address: '127.0.0.1', family: 4 }] },
    });
    expect(deliveries[0]).toMatchObject({ statusCode: 204, errorMessage: null });
  });
});
