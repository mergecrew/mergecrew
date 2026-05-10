/**
 * Conformance test for the Gitea VCS adapter (#204).
 *
 * Same shape as github.test.ts, but Gitea goes directly through fetch
 * (no SDK), so we stub global fetch instead of mocking @octokit/rest.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GiteaProvider } from '../src/gitea.js';
import {
  expectValidMergeResult,
  expectValidPullRequest,
  expectValidPullRequestFile,
  expectValidVcsEvent,
  makeRepoRef,
} from './conformance.js';

const repo = makeRepoRef();
let provider: GiteaProvider;

beforeEach(() => {
  provider = new GiteaProvider({
    token: 'gta_test_token',
    baseUrl: 'https://gitea.example.com',
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function jsonResponse(body: unknown, init: { status?: number } = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json' },
  });
}

function stubFetch(...responses: Response[]): ReturnType<typeof vi.fn> {
  const queue = [...responses];
  const fn = vi.fn(async () => queue.shift() ?? jsonResponse({}, { status: 500 }));
  vi.stubGlobal('fetch', fn);
  return fn;
}

describe('GiteaProvider — conformance (PR operations)', () => {
  it('openPullRequest returns a well-shaped PullRequest', async () => {
    stubFetch(
      jsonResponse({
        number: 42,
        html_url: 'https://gitea.example.com/test-org/test-repo/pulls/42',
        state: 'open',
        merged: false,
      }),
    );
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

  it('openPullRequest maps merged flag to "merged" state', async () => {
    stubFetch(
      jsonResponse({
        number: 43,
        html_url: 'https://gitea.example.com/o/r/pulls/43',
        state: 'closed',
        merged: true,
      }),
    );
    const pr = await provider.openPullRequest(repo, {
      head: 'f',
      base: 'main',
      title: 'X',
      body: 'why',
    });
    expect(pr.state).toBe('merged');
  });

  it('mergePullRequest returns a well-shaped MergeResult', async () => {
    stubFetch(
      // /merge POST — returns 200 no body of interest
      new Response(null, { status: 200 }),
      // /pulls/{n} GET — returns the merged PR
      jsonResponse({ merge_commit_sha: 'abcdef0', merged: true }),
    );
    const r = await provider.mergePullRequest(repo, 42, { method: 'squash' });
    expectValidMergeResult(r);
    expect(r.merged).toBe(true);
    expect(r.sha).toBe('abcdef0');
  });

  it('commentOnPullRequest sends to /issues/{n}/comments', async () => {
    const fetchMock = stubFetch(jsonResponse({}));
    const r = await provider.commentOnPullRequest(repo, 42, 'a comment');
    expect(r).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/repos/test-org/test-repo/issues/42/comments'),
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('closePullRequest sends a state=closed PATCH', async () => {
    const fetchMock = stubFetch(jsonResponse({}));
    await provider.closePullRequest(repo, 42);
    const call = fetchMock.mock.calls[0];
    expect(call?.[0]).toContain('/repos/test-org/test-repo/pulls/42');
    expect(call?.[1]).toMatchObject({ method: 'PATCH' });
    expect(JSON.parse(call?.[1]?.body as string)).toEqual({ state: 'closed' });
  });

  it('listOpenPullRequests returns valid PullRequests', async () => {
    stubFetch(
      jsonResponse([
        {
          number: 1,
          html_url: 'https://gitea.example.com/o/r/pulls/1',
          head: { ref: 'a' },
        },
        {
          number: 2,
          html_url: 'https://gitea.example.com/o/r/pulls/2',
          head: { ref: 'b' },
        },
      ]),
    );
    const list = await provider.listOpenPullRequests(repo);
    expect(list.length).toBe(2);
    for (const pr of list) {
      expectValidPullRequest(pr);
      expect(pr.state).toBe('open');
    }
  });

  it('getDefaultBranch returns the branch string', async () => {
    stubFetch(jsonResponse({ default_branch: 'main' }));
    const b = await provider.getDefaultBranch(repo);
    expect(b).toBe('main');
  });

  it('getDefaultBranch falls back to "main" when the field is missing', async () => {
    stubFetch(jsonResponse({}));
    const b = await provider.getDefaultBranch(repo);
    expect(b).toBe('main');
  });
});

describe('GiteaProvider — conformance (file fetch)', () => {
  it('getFileAt returns base64 content for a file', async () => {
    stubFetch(jsonResponse({ type: 'file', content: 'aGVsbG8=' }));
    const r = await provider.getFileAt(repo, 'main', 'README.md');
    expect(r.contentBase64).toBe('aGVsbG8=');
  });

  it('getFileAt rejects when the path resolves to a directory', async () => {
    stubFetch(jsonResponse([]));
    await expect(provider.getFileAt(repo, 'main', 'src/')).rejects.toThrow(/not a file/);
  });

  it('getPullRequestFiles paginates and parses', async () => {
    stubFetch(
      jsonResponse([
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
      ]),
    );
    const files = await provider.getPullRequestFiles(repo, 42);
    expect(files.length).toBe(2);
    for (const f of files) expectValidPullRequestFile(f);
    expect(files[0]?.status).toBe('modified');
    expect(files[1]?.status).toBe('renamed');
    expect(files[1]?.oldPath).toBe('old.ts');
  });

  it('getPullRequestFiles handles the deleted-file status that Gitea uses (vs GitHub\'s removed)', async () => {
    stubFetch(
      jsonResponse([
        { filename: 'gone.ts', status: 'deleted', additions: 0, deletions: 5 },
      ]),
    );
    const files = await provider.getPullRequestFiles(repo, 42);
    expect(files[0]?.status).toBe('removed');
  });
});

describe('GiteaProvider — conformance (webhooks)', () => {
  const SECRET = 'webhook-secret';

  function sign(body: Buffer, secret: string): string {
    return crypto.createHmac('sha256', secret).update(body).digest('hex');
  }

  it('verifyWebhookSignature accepts a correctly-signed payload', async () => {
    const body = Buffer.from('{"hello":"world"}');
    const ok = await provider.verifyWebhookSignature(
      { 'x-gitea-signature': sign(body, SECRET) },
      body,
      SECRET,
    );
    expect(ok).toBe(true);
  });

  it('verifyWebhookSignature rejects a tampered payload', async () => {
    const body = Buffer.from('{"hello":"world"}');
    const sig = sign(body, SECRET);
    const ok = await provider.verifyWebhookSignature(
      { 'x-gitea-signature': sig },
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
    const e = provider.parseWebhookEvent({ 'x-gitea-event': 'pull_request' }, body);
    expectValidVcsEvent(e);
    expect(e.kind).toBe('pull_request');
    if (e.kind === 'pull_request') {
      expect(e.action).toBe('opened');
      expect(e.prNumber).toBe(7);
      expect(e.repoFullName).toBe('o/r');
    }
  });

  it('parseWebhookEvent surfaces push as "unknown" (Gitea has no first-class workflow_run)', () => {
    const e = provider.parseWebhookEvent(
      { 'x-gitea-event': 'push' },
      Buffer.from('{"ref":"refs/heads/main"}'),
    );
    expectValidVcsEvent(e);
    expect(e.kind).toBe('unknown');
  });
});

describe('GiteaProvider — surface', () => {
  it('exposes id "gitea"', () => {
    expect(provider.id).toBe('gitea');
  });

  it('rejects an invalid baseUrl at construction time', () => {
    expect(() => new GiteaProvider({ token: 't', baseUrl: 'not a url' })).toThrow(
      /invalid baseUrl/,
    );
  });

  it('parseRepo rejects malformed repoFullName via openPullRequest path', async () => {
    stubFetch(jsonResponse({}));
    await expect(
      provider.openPullRequest(makeRepoRef({ repoFullName: 'no-slash' }), {
        head: 'h',
        base: 'b',
        title: 'X',
        body: 'Y',
      }),
    ).rejects.toThrow(/invalid repoFullName/);
  });

  it('throws on a non-2xx HTTP response', async () => {
    stubFetch(new Response('boom', { status: 500 }));
    await expect(provider.getDefaultBranch(repo)).rejects.toThrow(/gitea 500/);
  });
});

import crypto from 'node:crypto';
