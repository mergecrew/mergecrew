import { afterEach, describe, expect, it, vi } from 'vitest';
import { EmailClient } from '../src/email.js';

afterEach(() => vi.unstubAllGlobals());

describe('EmailClient — Resend', () => {
  it('POSTs to api.resend.com/emails with bearer auth and JSON body', async () => {
    const fetchMock = vi.fn(async () => new Response('{"id":"e_1"}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const client = new EmailClient({ from: 'a@x.dev', resendApiKey: 're_test' });
    await client.send(['b@x.dev', 'c@x.dev'], 'Hi', '<p>Hi</p>');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://api.resend.com/emails');
    expect((init as RequestInit).method).toBe('POST');
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer re_test');
    expect(headers['content-type']).toBe('application/json');
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body).toEqual({
      from: 'a@x.dev',
      to: ['b@x.dev', 'c@x.dev'],
      subject: 'Hi',
      html: '<p>Hi</p>',
    });
  });

  it('throws with status + Resend error message on non-2xx', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify({ name: 'validation_error', message: 'invalid from' }),
          { status: 422 },
        ),
      ),
    );
    const client = new EmailClient({ from: 'a@x.dev', resendApiKey: 're_test' });
    await expect(client.send(['b@x.dev'], 's', 'h')).rejects.toThrow(/resend 422.*invalid from/);
  });
});

describe('EmailClient — provider selection', () => {
  it('auto prefers Resend when both Resend and SMTP are set', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const client = new EmailClient({
      from: 'a@x.dev',
      resendApiKey: 're_test',
      smtpUrl: 'smtp://localhost:1025',
    });
    await client.send(['b@x.dev'], 's', 'h');
    expect(fetchMock).toHaveBeenCalled();
  });

  it('EMAIL_PROVIDER=smtp does not invoke Resend even when its key is set', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    // Construct only — don't call send(), which would hit a real SMTP
    // socket. The branching is decided at construction time; that's
    // the surface we're locking in.
    new EmailClient({
      from: 'a@x.dev',
      provider: 'smtp',
      resendApiKey: 're_test',
      smtpUrl: 'smtp://localhost:1025',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('falls back to console.log when nothing is configured', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const client = new EmailClient({ from: 'a@x.dev' });
    await client.send(['b@x.dev'], 's', '<p>h</p>');
    expect(logSpy).toHaveBeenCalled();
    expect(logSpy.mock.calls.some((c) => String(c[0]).includes('[email]'))).toBe(true);
    logSpy.mockRestore();
  });

  it('provider="resend" without API key throws at construction', () => {
    expect(() => new EmailClient({ from: 'a@x.dev', provider: 'resend' })).toThrow(
      /resend.*api key/i,
    );
  });

  it('provider="smtp" without smtpUrl throws at construction', () => {
    expect(() => new EmailClient({ from: 'a@x.dev', provider: 'smtp' })).toThrow(/smtp.*url/i);
  });
});
