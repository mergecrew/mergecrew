/**
 * Reference conformance test for the GitHub VCS adapter (V2.3, #27).
 *
 * This file is the template new VCS adapter authors should copy: mock
 * the vendor SDK / HTTP layer at a single seam, drive each `VcsProvider`
 * method through a representative scenario, and validate the runtime
 * contract via the helpers in `./conformance.ts`.
 *
 * GitHub goes through @octokit/rest + @octokit/auth-app, so we mock
 * those modules. Adapters that hit the vendor REST API directly (no
 * SDK) should `vi.stubGlobal('fetch', …)` instead — see the deploy
 * adapter conformance pattern in `packages/adapters-deploy/test/render.test.ts`.
 *
 * Git-shell methods (clone, branch, commit, push) are exercised by
 * `apps/dogfood-smoke` against a real repo — out of scope here.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const kitMock = {
  pulls: {
    create: vi.fn(),
    merge: vi.fn(),
    update: vi.fn(),
    list: vi.fn(),
    get: vi.fn(),
    listFiles: vi.fn(),
    createReview: vi.fn(),
  },
  issues: {
    createComment: vi.fn(),
  },
  repos: {
    get: vi.fn(),
    getContent: vi.fn(),
  },
  paginate: vi.fn(async (method: any, opts: any) => {
    const r = await method(opts);
    return r.data;
  }),
  graphql: vi.fn(),
};

vi.mock('@octokit/auth-app', () => ({
  createAppAuth: () => async () => ({ token: 'gh_test_token' }),
}));

vi.mock('@octokit/rest', () => ({
  Octokit: vi.fn().mockImplementation(() => kitMock),
}));

import { GitHubProvider } from '../src/github.js';
import {
  expectValidMergeResult,
  expectValidPullRequest,
  expectValidPullRequestFile,
  expectValidVcsEvent,
  makeRepoRef,
} from './conformance.js';

const repo = makeRepoRef();
let provider: GitHubProvider;

beforeEach(() => {
  provider = new GitHubProvider({ appId: '1', privateKey: 'TEST' });
  for (const group of Object.values(kitMock)) {
    if (typeof group === 'function') continue;
    for (const fn of Object.values(group)) {
      if (typeof fn === 'function' && 'mockReset' in fn) (fn as any).mockReset();
    }
  }
  kitMock.paginate.mockClear();
  kitMock.paginate.mockImplementation(async (method: any, opts: any) => {
    const r = await method(opts);
    return r.data;
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('GitHubProvider — conformance (PR operations)', () => {
  it('openPullRequest returns a well-shaped PullRequest', async () => {
    kitMock.pulls.create.mockResolvedValueOnce({
      data: {
        number: 42,
        html_url: 'https://github.com/test-org/test-repo/pull/42',
        state: 'open',
        merged_at: null,
      },
    });
    const pr = await provider.openPullRequest(repo, {
      head: 'feature',
      base: 'main',
      title: 'X',
      body: 'why',
    });
    expectValidPullRequest(pr);
    expect(pr.number).toBe(42);
    expect(pr.state).toBe('open');
    expect(pr.branch).toBe('feature');
  });

  it('openPullRequest maps closed-and-merged to "merged" state', async () => {
    kitMock.pulls.create.mockResolvedValueOnce({
      data: {
        number: 43,
        html_url: 'https://github.com/test-org/test-repo/pull/43',
        state: 'closed',
        merged_at: '2026-05-10T00:00:00Z',
      },
    });
    const pr = await provider.openPullRequest(repo, {
      head: 'f',
      base: 'main',
      title: 'X',
      body: 'why',
    });
    expect(pr.state).toBe('merged');
  });

  it('mergePullRequest returns a well-shaped MergeResult', async () => {
    kitMock.pulls.merge.mockResolvedValueOnce({
      data: { sha: 'abcdef0', merged: true },
    });
    const r = await provider.mergePullRequest(repo, 42, { method: 'squash' });
    expectValidMergeResult(r);
    expect(r.merged).toBe(true);
  });

  it('commentOnPullRequest resolves without returning anything', async () => {
    kitMock.issues.createComment.mockResolvedValueOnce({ data: {} });
    const r = await provider.commentOnPullRequest(repo, 42, 'a comment');
    expect(r).toBeUndefined();
    expect(kitMock.issues.createComment).toHaveBeenCalledWith(
      expect.objectContaining({ issue_number: 42, body: 'a comment' }),
    );
  });

  it('postReview maps approve → APPROVE and forwards the body', async () => {
    kitMock.pulls.createReview.mockResolvedValueOnce({ data: { id: 99 } });
    await provider.postReview(repo, 42, { event: 'approve', body: 'looks good' });
    expect(kitMock.pulls.createReview).toHaveBeenCalledWith(
      expect.objectContaining({
        pull_number: 42,
        event: 'APPROVE',
        body: 'looks good',
      }),
    );
    // No comments → comments key must NOT be present (GitHub rejects [] arrays).
    const call = kitMock.pulls.createReview.mock.calls[0]![0] as Record<string, unknown>;
    expect('comments' in call).toBe(false);
  });

  it('postReview maps request_changes → REQUEST_CHANGES and forwards inline comments', async () => {
    kitMock.pulls.createReview.mockResolvedValueOnce({ data: { id: 100 } });
    await provider.postReview(repo, 42, {
      event: 'request_changes',
      body: 'see inline',
      comments: [
        { path: 'src/index.ts', line: 12, body: 'off-by-one' },
        { path: 'src/util.ts', line: 7, body: 'unused import' },
      ],
    });
    expect(kitMock.pulls.createReview).toHaveBeenCalledWith(
      expect.objectContaining({
        pull_number: 42,
        event: 'REQUEST_CHANGES',
        body: 'see inline',
        comments: [
          { path: 'src/index.ts', line: 12, side: 'RIGHT', body: 'off-by-one' },
          { path: 'src/util.ts', line: 7, side: 'RIGHT', body: 'unused import' },
        ],
      }),
    );
  });

  it('postReview maps comment → COMMENT', async () => {
    kitMock.pulls.createReview.mockResolvedValueOnce({ data: { id: 101 } });
    await provider.postReview(repo, 42, { event: 'comment', body: 'fyi' });
    expect(kitMock.pulls.createReview).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'COMMENT', body: 'fyi' }),
    );
  });

  it('markReadyForReview fetches the PR node_id and fires the GraphQL mutation', async () => {
    kitMock.pulls.get.mockResolvedValueOnce({
      data: { number: 42, node_id: 'PR_kwDOFakeNode' },
    });
    kitMock.graphql.mockResolvedValueOnce({
      markPullRequestReadyForReview: { pullRequest: { isDraft: false } },
    });
    await provider.markReadyForReview(repo, 42);
    expect(kitMock.pulls.get).toHaveBeenCalledWith(
      expect.objectContaining({ pull_number: 42 }),
    );
    expect(kitMock.graphql).toHaveBeenCalledWith(
      expect.stringContaining('markPullRequestReadyForReview'),
      expect.objectContaining({ id: 'PR_kwDOFakeNode' }),
    );
  });

  it('markReadyForReview throws when GitHub omits node_id (defensive)', async () => {
    kitMock.pulls.get.mockResolvedValueOnce({ data: { number: 42 } });
    await expect(provider.markReadyForReview(repo, 42)).rejects.toThrow(/node_id/);
    expect(kitMock.graphql).not.toHaveBeenCalled();
  });

  it('closePullRequest sends a state=closed update', async () => {
    kitMock.pulls.update.mockResolvedValueOnce({ data: {} });
    await provider.closePullRequest(repo, 42);
    expect(kitMock.pulls.update).toHaveBeenCalledWith(
      expect.objectContaining({ pull_number: 42, state: 'closed' }),
    );
  });

  it('listOpenPullRequests returns valid PullRequests', async () => {
    kitMock.pulls.list.mockResolvedValueOnce({
      data: [
        {
          number: 1,
          html_url: 'https://github.com/test-org/test-repo/pull/1',
          head: { ref: 'a' },
        },
        {
          number: 2,
          html_url: 'https://github.com/test-org/test-repo/pull/2',
          head: { ref: 'b' },
        },
      ],
    });
    const list = await provider.listOpenPullRequests(repo);
    expect(list.length).toBe(2);
    for (const pr of list) {
      expectValidPullRequest(pr);
      expect(pr.state).toBe('open');
    }
  });

  it('getDefaultBranch returns the branch name string', async () => {
    kitMock.repos.get.mockResolvedValueOnce({ data: { default_branch: 'main' } });
    const b = await provider.getDefaultBranch(repo);
    expect(b).toBe('main');
  });
});

describe('GitHubProvider — conformance (file fetch)', () => {
  it('getFileAt returns base64 content for a file', async () => {
    kitMock.repos.getContent.mockResolvedValueOnce({
      data: { type: 'file', content: 'aGVsbG8=' },
    });
    const r = await provider.getFileAt(repo, 'main', 'README.md');
    expect(r.contentBase64).toBe('aGVsbG8=');
  });

  it('getFileAt rejects when the path resolves to a directory', async () => {
    kitMock.repos.getContent.mockResolvedValueOnce({ data: [] });
    await expect(provider.getFileAt(repo, 'main', 'src/')).rejects.toThrow(/not a file/);
  });

  it('getPullRequestFiles returns a parsed PullRequestFile list', async () => {
    kitMock.pulls.listFiles.mockResolvedValueOnce({
      data: [
        {
          filename: 'a.ts',
          status: 'modified',
          additions: 3,
          deletions: 1,
          patch: '@@ -1,2 +1,4 @@\n line\n+added\n+added2\n line\n',
        },
        {
          filename: 'b.ts',
          status: 'renamed',
          previous_filename: 'old.ts',
          additions: 0,
          deletions: 0,
          patch: undefined,
        },
      ],
    });
    const files = await provider.getPullRequestFiles(repo, 42);
    expect(files.length).toBe(2);
    for (const f of files) expectValidPullRequestFile(f);
    expect(files[0]?.status).toBe('modified');
    expect(files[1]?.status).toBe('renamed');
    expect(files[1]?.oldPath).toBe('old.ts');
  });
});

describe('GitHubProvider — conformance (webhooks)', () => {
  const SECRET = 'webhook-secret';

  function sign(body: Buffer, secret: string): string {
    const c = require('node:crypto');
    return 'sha256=' + c.createHmac('sha256', secret).update(body).digest('hex');
  }

  it('verifyWebhookSignature accepts a correctly-signed payload', async () => {
    const body = Buffer.from('{"hello":"world"}');
    const ok = await provider.verifyWebhookSignature(
      { 'x-hub-signature-256': sign(body, SECRET) },
      body,
      SECRET,
    );
    expect(ok).toBe(true);
  });

  it('verifyWebhookSignature rejects a tampered payload', async () => {
    const body = Buffer.from('{"hello":"world"}');
    const sig = sign(body, SECRET);
    const ok = await provider.verifyWebhookSignature(
      { 'x-hub-signature-256': sig },
      Buffer.from('{"hello":"WORLD"}'),
      SECRET,
    );
    expect(ok).toBe(false);
  });

  it('verifyWebhookSignature rejects when the header is missing', async () => {
    const ok = await provider.verifyWebhookSignature({}, Buffer.from('{}'), SECRET);
    expect(ok).toBe(false);
  });

  it('parseWebhookEvent extracts pull_request shape', () => {
    const body = Buffer.from(
      JSON.stringify({
        action: 'opened',
        pull_request: { number: 7 },
        repository: { full_name: 'o/r' },
      }),
    );
    const e = provider.parseWebhookEvent({ 'x-github-event': 'pull_request' }, body);
    expectValidVcsEvent(e);
    expect(e.kind).toBe('pull_request');
    if (e.kind === 'pull_request') {
      expect(e.action).toBe('opened');
      expect(e.prNumber).toBe(7);
      expect(e.repoFullName).toBe('o/r');
    }
  });

  it('parseWebhookEvent falls back to "unknown" for unrecognized events', () => {
    const e = provider.parseWebhookEvent(
      { 'x-github-event': 'star' },
      Buffer.from('{"action":"created"}'),
    );
    expectValidVcsEvent(e);
    expect(e.kind).toBe('unknown');
  });
});

describe('GitHubProvider — surface', () => {
  it('exposes id "github"', () => {
    expect(provider.id).toBe('github');
  });

  it('parseRepo rejects malformed repoFullName via openPullRequest path', async () => {
    await expect(
      provider.openPullRequest(makeRepoRef({ repoFullName: 'no-slash' }), {
        head: 'h',
        base: 'b',
        title: 'X',
        body: 'Y',
      }),
    ).rejects.toThrow(/invalid repoFullName/);
  });
});

describe('GitHubProvider — GHES base URL (#205)', () => {
  it('points Octokit at the GHES /api/v3 endpoint when baseUrl is set', async () => {
    const ghes = new GitHubProvider({
      appId: '1',
      privateKey: 'TEST',
      baseUrl: 'https://github.example.com',
    });
    kitMock.repos.get.mockResolvedValueOnce({ data: { default_branch: 'main' } });
    await ghes.getDefaultBranch(makeRepoRef());

    // Octokit was constructed with the GHES API URL.
    const { Octokit } = await import('@octokit/rest');
    const calls = (Octokit as unknown as { mock: { calls: any[][] } }).mock.calls;
    const lastCallOpts = calls[calls.length - 1]?.[0];
    expect(lastCallOpts).toBeDefined();
    expect(lastCallOpts.baseUrl).toBe('https://github.example.com/api/v3');
  });

  it('rejects an invalid baseUrl at construction time', () => {
    expect(
      () => new GitHubProvider({ appId: '1', privateKey: 'TEST', baseUrl: 'not a url' }),
    ).toThrow(/invalid baseUrl/);
  });

  it('defaults to github.com when no baseUrl is provided', async () => {
    const gh = new GitHubProvider({ appId: '1', privateKey: 'TEST' });
    kitMock.repos.get.mockResolvedValueOnce({ data: { default_branch: 'main' } });
    await gh.getDefaultBranch(makeRepoRef());

    const { Octokit } = await import('@octokit/rest');
    const calls = (Octokit as unknown as { mock: { calls: any[][] } }).mock.calls;
    const lastCallOpts = calls[calls.length - 1]?.[0];
    // Octokit's default points at api.github.com; passing baseUrl
    // explicitly when it isn't needed would be drift, so the
    // happy-path code path passes only `auth` here.
    expect(lastCallOpts.baseUrl).toBe('https://api.github.com');
  });
});
