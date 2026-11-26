import { describe, expect, it } from 'vitest';
import {
  buildForwardHeaders,
  buildResponseHeaders,
  isPublicApiPath,
  safeApiPath,
} from '../src/lib/api-proxy';

describe('safeApiPath', () => {
  it('joins ordinary segments', () => {
    expect(safeApiPath(['orgs', 'acme', 'projects', 'web', 'runs'])).toBe('orgs/acme/projects/web/runs');
    expect(safeApiPath(['orgs', 'acme', 'runs', '0b6c1f6e-6c0a-4a43-9b8e-2f0a3c7b9d11'])).toBe(
      'orgs/acme/runs/0b6c1f6e-6c0a-4a43-9b8e-2f0a3c7b9d11',
    );
  });

  it('rejects dot segments', () => {
    expect(safeApiPath(['..', 'metrics'])).toBeNull();
    expect(safeApiPath(['orgs', '.', 'x'])).toBeNull();
    expect(safeApiPath(['orgs', '..'])).toBeNull();
  });

  it('rejects segments carrying separators once decoded', () => {
    // Next decodes `..%2Fmetrics` into a single `../metrics` segment.
    expect(safeApiPath(['../metrics'])).toBeNull();
    expect(safeApiPath(['orgs', 'a/b'])).toBeNull();
    expect(safeApiPath(['orgs', 'a\\b'])).toBeNull();
  });

  it('rejects still-encoded separators (double encoding)', () => {
    expect(safeApiPath(['..%2Fmetrics'])).toBeNull();
    expect(safeApiPath(['%2e%2e', 'metrics'])).toBeNull();
    expect(safeApiPath(['orgs', 'a%5cb'])).toBeNull();
  });

  it('rejects empty input and empty segments', () => {
    expect(safeApiPath([])).toBeNull();
    expect(safeApiPath(['orgs', ''])).toBeNull();
  });
});

describe('buildForwardHeaders', () => {
  it('drops cookies and client-supplied identity headers', () => {
    const out = buildForwardHeaders(
      new Headers({
        cookie: 'next-auth.session-token=abc',
        'x-mergecrew-user-id': '00000000-0000-0000-0000-000000000001',
        'x-forwarded-for': '1.2.3.4',
        host: 'evil.example',
        'content-type': 'application/json',
        accept: 'text/event-stream',
        'last-event-id': 'evt-1',
        authorization: 'Bearer mc_live_x',
      }),
    );
    expect(out.get('cookie')).toBeNull();
    expect(out.get('x-mergecrew-user-id')).toBeNull();
    // Re-derived single client address (last hop appended by Caddy).
    expect(out.get('x-forwarded-for')).toBe('1.2.3.4');
    expect(out.get('host')).toBeNull();
    expect(out.get('content-type')).toBe('application/json');
    expect(out.get('accept')).toBe('text/event-stream');
    expect(out.get('last-event-id')).toBe('evt-1');
    expect(out.get('authorization')).toBe('Bearer mc_live_x');
  });
});

describe('client address forwarding', () => {
  it('keeps only the proxy-appended address from a spoofed chain', () => {
    const out = buildForwardHeaders(new Headers({ 'x-forwarded-for': '6.6.6.6, 9.9.9.9' }));
    expect(out.get('x-forwarded-for')).toBe('9.9.9.9');
  });

  it('falls back to x-real-ip and omits the header when nothing is known', () => {
    expect(buildForwardHeaders(new Headers({ 'x-real-ip': '5.5.5.5' })).get('x-forwarded-for')).toBe('5.5.5.5');
    expect(buildForwardHeaders(new Headers()).get('x-forwarded-for')).toBeNull();
  });
});

describe('buildResponseHeaders', () => {
  it('strips hop-by-hop headers', () => {
    const out = buildResponseHeaders(
      new Headers({ connection: 'keep-alive', 'content-type': 'text/event-stream', 'content-length': '5' }),
    );
    expect(out.get('connection')).toBeNull();
    expect(out.get('content-length')).toBeNull();
    expect(out.get('content-type')).toBe('text/event-stream');
  });
});

describe('isPublicApiPath', () => {
  it('only allows the explicit public prefixes', () => {
    expect(isPublicApiPath('skills')).toBe(true);
    expect(isPublicApiPath('lifecycle-templates/stock/default')).toBe(true);
    expect(isPublicApiPath('notifications/unsubscribe')).toBe(true);
    expect(isPublicApiPath('orgs/acme')).toBe(false);
    expect(isPublicApiPath('auth/login')).toBe(false);
    expect(isPublicApiPath('skillsx')).toBe(false);
  });
});
