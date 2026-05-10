import { describe, expect, it, vi } from 'vitest';
import { createMergecrew } from '../src/index.js';

describe('createMergecrew', () => {
  it('attaches the bearer header and respects baseUrl', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ items: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    const mc = createMergecrew({
      apiKey: 'mc_live_test-secret',
      baseUrl: 'http://localhost:4000',
      clientOptions: { fetch: fetchMock as any },
    });

    const res = await mc.GET('/v1/orgs/{slug}/projects', {
      params: { path: { slug: 'demo' } },
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    const req = fetchMock.mock.calls[0]![0] as Request;
    expect(req.url).toBe('http://localhost:4000/v1/orgs/demo/projects');
    expect(req.headers.get('authorization')).toBe('Bearer mc_live_test-secret');
    expect(res.error).toBeUndefined();
  });

  it('defaults baseUrl to the production host', async () => {
    const fetchMock = vi.fn(async () =>
      new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }),
    );

    const mc = createMergecrew({
      apiKey: 'mc_live_anything',
      clientOptions: { fetch: fetchMock as any },
    });
    await mc.GET('/v1/orgs/{slug}/projects', { params: { path: { slug: 'demo' } } });

    const req = fetchMock.mock.calls[0]![0] as Request;
    expect(req.url.startsWith('https://api.mergecrew.dev/')).toBe(true);
  });
});
