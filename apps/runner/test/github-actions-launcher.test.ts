import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import crypto from 'node:crypto';
import pino from 'pino';

const logger = pino({ level: 'silent' });

vi.mock('@mergecrew/db', () => ({
  withSystem: (fn: any) =>
    fn({
      runnerAgent: {
        create: async ({ data }: any) => ({
          id: 'agent-row-id',
          ...data,
        }),
      },
    }),
}));

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  // @ts-expect-error — test override
  globalThis.fetch = fetchMock;
});

afterEach(() => {
  // @ts-expect-error — test override
  delete globalThis.fetch;
});

// Build a real ciphertext using the same envelope-encryption layout
// CryptoService writes, so the launcher's decryptToken roundtrips.
function makeCiphertext(plain: string, masterKey: Buffer): Uint8Array {
  const dataKey = crypto.randomBytes(32);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', dataKey, iv);
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  const wrapIv = crypto.randomBytes(12);
  const wrapCipher = crypto.createCipheriv('aes-256-gcm', masterKey, wrapIv);
  const wrapped = Buffer.concat([wrapCipher.update(dataKey), wrapCipher.final()]);
  const wrapTag = wrapCipher.getAuthTag();
  return new Uint8Array(
    Buffer.concat([Buffer.from([1]), wrapIv, wrapTag, wrapped, iv, tag, ct]),
  );
}

describe('launchGithubActionsWorkflow', () => {
  it('mints a per-step agent token, resolves default branch, posts workflow_dispatch', async () => {
    const masterKey = crypto.randomBytes(32);
    process.env.KMS_MASTER_KEY = `base64:${masterKey.toString('base64')}`;
    const cipher = makeCiphertext('ghp_fake_pat', masterKey);

    fetchMock
      // GET /repos/{owner}/{repo} for default_branch resolution
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ default_branch: 'develop' }), { status: 200 }),
      )
      // POST workflows/.../dispatches → 204 on success
      .mockResolvedValueOnce(new Response(null, { status: 204 }));

    const { launchGithubActionsWorkflow } = await import(
      '../src/github-actions-launcher.js'
    );
    const r = await launchGithubActionsWorkflow({
      organizationId: 'org-1',
      organizationSlug: 'acme',
      stepId: 'step-xyz',
      runId: 'run-1',
      profile: {
        githubRepoFullName: 'acme/widget',
        githubWorkflowFileName: 'mergecrew-runner.yml',
        githubTokenCiphertext: cipher,
      },
      apiBaseUrl: 'https://mergecrew.dev',
      logger,
    });

    expect(r.repoFullName).toBe('acme/widget');
    expect(r.agentId).toBe('agent-row-id');

    // Default-branch resolution
    expect(fetchMock.mock.calls[0]![0]).toBe('https://api.github.com/repos/acme/widget');
    const repoReqInit = fetchMock.mock.calls[0]![1] as RequestInit;
    expect((repoReqInit.headers as any).authorization).toBe('Bearer ghp_fake_pat');

    // Workflow dispatch URL + body
    expect(fetchMock.mock.calls[1]![0]).toBe(
      'https://api.github.com/repos/acme/widget/actions/workflows/mergecrew-runner.yml/dispatches',
    );
    const dispatchInit = fetchMock.mock.calls[1]![1] as RequestInit;
    expect((dispatchInit.headers as any).authorization).toBe('Bearer ghp_fake_pat');
    const body = JSON.parse(String(dispatchInit.body));
    expect(body.ref).toBe('develop');
    expect(body.inputs.mergecrewStepId).toBe('step-xyz');
    expect(body.inputs.mergecrewApiUrl).toBe('https://mergecrew.dev');
    expect(body.inputs.mergecrewAgentToken).toMatch(/^mca_acme_[A-Z2-7]{26}$/);
  });

  it('falls back to "main" when GET /repos doesn\'t expose default_branch', async () => {
    const masterKey = crypto.randomBytes(32);
    process.env.KMS_MASTER_KEY = `base64:${masterKey.toString('base64')}`;
    const cipher = makeCiphertext('ghp_x', masterKey);

    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({}), { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));

    const { launchGithubActionsWorkflow } = await import(
      '../src/github-actions-launcher.js'
    );
    await launchGithubActionsWorkflow({
      organizationId: 'o',
      organizationSlug: 'a',
      stepId: 's',
      runId: 'r',
      profile: {
        githubRepoFullName: 'a/b',
        githubWorkflowFileName: 'w.yml',
        githubTokenCiphertext: cipher,
      },
      apiBaseUrl: 'https://api',
      logger,
    });
    const body = JSON.parse(String((fetchMock.mock.calls[1]![1] as RequestInit).body));
    expect(body.ref).toBe('main');
  });

  it('throws with status + body when workflow_dispatch returns non-204', async () => {
    const masterKey = crypto.randomBytes(32);
    process.env.KMS_MASTER_KEY = `base64:${masterKey.toString('base64')}`;
    const cipher = makeCiphertext('ghp_x', masterKey);

    fetchMock
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ default_branch: 'main' }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ message: 'workflow file not found' }), { status: 422 }),
      );

    const { launchGithubActionsWorkflow } = await import(
      '../src/github-actions-launcher.js'
    );
    await expect(
      launchGithubActionsWorkflow({
        organizationId: 'o',
        organizationSlug: 'a',
        stepId: 's',
        runId: 'r',
        profile: {
          githubRepoFullName: 'a/b',
          githubWorkflowFileName: 'missing.yml',
          githubTokenCiphertext: cipher,
        },
        apiBaseUrl: 'https://api',
        logger,
      }),
    ).rejects.toThrow(/422.*workflow file not found/);
  });

  it('throws when GET /repos rejects (PAT lacks access)', async () => {
    const masterKey = crypto.randomBytes(32);
    process.env.KMS_MASTER_KEY = `base64:${masterKey.toString('base64')}`;
    const cipher = makeCiphertext('ghp_x', masterKey);

    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 }),
    );

    const { launchGithubActionsWorkflow } = await import(
      '../src/github-actions-launcher.js'
    );
    await expect(
      launchGithubActionsWorkflow({
        organizationId: 'o',
        organizationSlug: 'a',
        stepId: 's',
        runId: 'r',
        profile: {
          githubRepoFullName: 'a/b',
          githubWorkflowFileName: 'w.yml',
          githubTokenCiphertext: cipher,
        },
        apiBaseUrl: 'https://api',
        logger,
      }),
    ).rejects.toThrow(/GET .* 404/);
  });

  it('throws on a malformed ciphertext (version != 1)', async () => {
    const masterKey = crypto.randomBytes(32);
    process.env.KMS_MASTER_KEY = `base64:${masterKey.toString('base64')}`;
    const badCipher = new Uint8Array([99, 0, 0, 0]);
    const { launchGithubActionsWorkflow } = await import(
      '../src/github-actions-launcher.js'
    );
    await expect(
      launchGithubActionsWorkflow({
        organizationId: 'o',
        organizationSlug: 'a',
        stepId: 's',
        runId: 'r',
        profile: {
          githubRepoFullName: 'a/b',
          githubWorkflowFileName: 'w.yml',
          githubTokenCiphertext: badCipher,
        },
        apiBaseUrl: 'https://api',
        logger,
      }),
    ).rejects.toThrow(/unknown ciphertext version/);
  });
});
