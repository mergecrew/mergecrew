/**
 * Boots the webhook controllers behind the real body-parser wiring
 * (`applyBodyParsers`, as AppModule uses it) and drives them over HTTP
 * with `application/json` POSTs — the case the GET-only raw-body
 * exclusion used to break.
 */
import crypto from 'node:crypto';
import { Body, Controller, MiddlewareConsumer, Module, NestModule, Post, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';

jest.mock('@mergecrew/adapters-vcs', () => ({
  getGitHubAppCredentials: () => ({ appId: '1', privateKey: 'k' }),
  GitHubProvider: class {
    parseWebhookEvent(headers: Record<string, string>, body: Buffer) {
      const json = JSON.parse(body.toString('utf8'));
      if (headers['x-github-event'] === 'installation') {
        return { kind: 'installation', action: json.action, installationId: String(json.installation?.id), raw: json };
      }
      return { kind: 'unknown', raw: json };
    }
  },
}));

import { applyBodyParsers } from '../../common/body-parsers';
import { QueueService } from '../../common/queue.service';
import { GitHubInstallationService } from '../integration/github-installation.service';
import { GitHubWebhookController } from './github-webhook.controller';
import { LinearWebhookController } from './linear-webhook.controller';
import { SentryWebhookController } from './sentry-webhook.controller';

const hmac = (key: string, data: Buffer | string) =>
  crypto.createHmac('sha256', key).update(data).digest('hex');

@Controller('v1/echo')
class EchoController {
  @Post()
  echo(@Body() body: unknown) {
    return { body };
  }
}

describe('webhook controllers over HTTP', () => {
  let app: INestApplication;
  let base: string;
  const add = jest.fn(async () => ({}));
  const handleInstallationEvent = jest.fn(async () => {});
  const savedEnv = { ...process.env };

  beforeAll(async () => {
    @Module({
      controllers: [GitHubWebhookController, LinearWebhookController, SentryWebhookController, EchoController],
      providers: [
        { provide: QueueService, useValue: { get: () => ({ add }) } },
        { provide: GitHubInstallationService, useValue: { handleInstallationEvent } },
      ],
    })
    class TestModule implements NestModule {
      configure(consumer: MiddlewareConsumer) {
        applyBodyParsers(consumer);
      }
    }
    const mod = await Test.createTestingModule({ imports: [TestModule] }).compile();
    app = mod.createNestApplication({ bodyParser: false, logger: false });
    await app.listen(0);
    base = await app.getUrl();
    base = base.replace('[::1]', '127.0.0.1');
  });

  afterAll(async () => {
    await app.close();
    process.env = savedEnv;
  });

  beforeEach(() => {
    add.mockClear();
    handleInstallationEvent.mockClear();
    process.env.GITHUB_APP_WEBHOOK_SECRET = 'gh-secret';
    process.env.LINEAR_WEBHOOK_SECRET = 'lin-secret';
    process.env.SENTRY_CLIENT_SECRET = 'sentry-secret';
  });

  const post = (path: string, body: string, headers: Record<string, string>) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body,
    });

  it('non-webhook routes still get parsed JSON', async () => {
    const r = await post('/v1/echo', '{"a":1}', {});
    expect(await r.json()).toEqual({ body: { a: 1 } });
  });

  describe('github', () => {
    const ping = JSON.stringify({ zen: 'Design for failure.', hook_id: 42 });

    it('accepts a correctly signed application/json ping', async () => {
      const r = await post('/v1/webhooks/github', ping, {
        'x-github-event': 'ping',
        'x-hub-signature-256': `sha256=${hmac('gh-secret', ping)}`,
      });
      expect(r.status).toBe(201);
      expect(add).toHaveBeenCalledTimes(1);
    });

    it('rejects an invalid signature', async () => {
      const r = await post('/v1/webhooks/github', ping, {
        'x-github-event': 'ping',
        'x-hub-signature-256': `sha256=${hmac('wrong', ping)}`,
      });
      expect(r.status).toBe(403);
      expect(add).not.toHaveBeenCalled();
    });

    it('rejects everything when the secret is empty', async () => {
      process.env.GITHUB_APP_WEBHOOK_SECRET = '';
      const r = await post('/v1/webhooks/github', ping, {
        'x-github-event': 'ping',
        'x-hub-signature-256': `sha256=${hmac('', ping)}`,
      });
      expect(r.status).toBe(403);
      expect(add).not.toHaveBeenCalled();
    });

    it('syncs bindings on installation.deleted', async () => {
      const body = JSON.stringify({ action: 'deleted', installation: { id: 777 } });
      const r = await post('/v1/webhooks/github', body, {
        'x-github-event': 'installation',
        'x-hub-signature-256': `sha256=${hmac('gh-secret', body)}`,
      });
      expect(r.status).toBe(201);
      expect(handleInstallationEvent).toHaveBeenCalledWith('deleted', '777');
    });
  });

  describe('linear', () => {
    const mk = () => JSON.stringify({ action: 'create', type: 'Issue', webhookTimestamp: Date.now() });

    it('accepts a valid signature', async () => {
      const body = mk();
      const r = await post('/v1/webhooks/linear', body, { 'linear-signature': hmac('lin-secret', body) });
      expect(r.status).toBe(201);
      expect(add).toHaveBeenCalledTimes(1);
    });

    it('rejects unsigned and invalid requests with 403', async () => {
      const body = mk();
      expect((await post('/v1/webhooks/linear', body, {})).status).toBe(403);
      expect((await post('/v1/webhooks/linear', body, { 'linear-signature': hmac('x', body) })).status).toBe(403);
      expect(add).not.toHaveBeenCalled();
    });

    it('rejects when the secret is unset', async () => {
      delete process.env.LINEAR_WEBHOOK_SECRET;
      const body = mk();
      const r = await post('/v1/webhooks/linear', body, { 'linear-signature': hmac('', body) });
      expect(r.status).toBe(403);
      expect(add).not.toHaveBeenCalled();
    });
  });

  describe('sentry', () => {
    const body = JSON.stringify({ action: 'created', data: {} });

    it('accepts a valid application/json signature', async () => {
      const r = await post('/v1/webhooks/sentry', body, { 'sentry-hook-signature': hmac('sentry-secret', body) });
      expect(r.status).toBe(201);
    });

    it('rejects invalid signature and empty secret', async () => {
      expect((await post('/v1/webhooks/sentry', body, { 'sentry-hook-signature': hmac('x', body) })).status).toBe(403);
      process.env.SENTRY_CLIENT_SECRET = '';
      expect((await post('/v1/webhooks/sentry', body, { 'sentry-hook-signature': hmac('', body) })).status).toBe(403);
      expect(add).not.toHaveBeenCalled();
    });
  });
});
