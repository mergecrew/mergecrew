import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpTransport } from '../src/http-transport.js';
import type { TelemetryEvent } from '../src/events.js';

const sampleEvent: TelemetryEvent = {
  type: 'org.created',
  installId: '00000000-0000-0000-0000-000000000001',
  occurredAt: '2026-05-11T00:00:00Z',
  version: '0.1.0',
};

describe('HttpTransport', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('POSTs the batch as JSON to the configured URL', async () => {
    (globalThis.fetch as any).mockResolvedValue(new Response(null, { status: 204 }));
    const t = new HttpTransport({ url: 'http://example.test/v1/events' });
    await t.send([sampleEvent]);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    const [url, init] = (globalThis.fetch as any).mock.calls[0];
    expect(url).toBe('http://example.test/v1/events');
    expect(init.method).toBe('POST');
    expect(init.headers['content-type']).toBe('application/json');
    expect(JSON.parse(init.body)).toEqual([sampleEvent]);
  });

  it('does not throw on a network failure', async () => {
    (globalThis.fetch as any).mockRejectedValue(new Error('ECONNREFUSED'));
    const t = new HttpTransport({ url: 'http://nowhere.invalid/' });
    await expect(t.send([sampleEvent])).resolves.toBeUndefined();
  });

  it('does not throw on a non-2xx response', async () => {
    (globalThis.fetch as any).mockResolvedValue(new Response('boom', { status: 500 }));
    const t = new HttpTransport({ url: 'http://example.test/v1/events' });
    await expect(t.send([sampleEvent])).resolves.toBeUndefined();
  });

  it('skips the POST entirely on an empty batch', async () => {
    const t = new HttpTransport({ url: 'http://example.test/v1/events' });
    await t.send([]);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});
