/**
 * Conformance test for the GitLab VCS adapter (#203).
 *
 * Same fetch-stubbing shape as gitea.test.ts. GitLab's vocabulary
 * differs (Merge Request, iid, project path), but the contract checks
 * via the helpers in conformance.ts catch the same drift either way.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import crypto from 'node:crypto';
import { GitLabProvider } from '../src/gitlab.js';
import {
  expectValidMergeResult,
  expectValidPullRequest,
  expectValidPullRequestFile,
  expectValidVcsEvent,
  makeRepoRef,
} from './conformance.js';

const repo = makeRepoRef();
let provider: GitLabProvider;

beforeEach(() => {
  provider = new GitLabProvider({
    token: 'glpat_test_token',
    baseUrl: 'https://gitlab.example.com',
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

describe('GitLabProvider — conformance (MR operations)', () => {
  it('openPullRequest returns a well-shaped PullRequest', async () => {
    stubFetch(
      jsonResponse({
        iid: 42,
        web_url: 'https://gitlab.example.com/test-org/test-repo/-/merge_requests/42',
        state: 'opened',
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

  it('openPullRequest maps merged state', async () => {
    stubFetch(
      jsonResponse({
        iid: 43,
        web_url: 'https://gitlab.example.com/o/r/-/merge_requests/43',
        state: 'merged',
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

  it('openPullRequest URL-encodes the project path', async () => {
    const fetchMock = stubFetch(
      jsonResponse({
        iid: 1,
        web_url: 'https://gitlab.example.com/o/r/-/merge_requests/1',
        state: 'opened',
      }),
    );
    await provider.openPullRequest(repo, {
      head: 'f',
      base: 'main',
      title: 'X',
      body: 'Y',
    });
    expect(fetchMock.mock.calls[0]?.[0]).toContain('/projects/test-org%2Ftest-repo/merge_requests');
  });

  it('mergePullRequest returns a well-shaped MergeResult', async () => {
    stubFetch(
      jsonResponse({
        state: 'merged',
        merge_commit_sha: 'abcdef0',
      }),
    );
    const r = await provider.mergePullRequest(repo, 42, { method: 'squash' });
    expectValidMergeResult(r);
    expect(r.merged).toBe(true);
    expect(r.sha).toBe('abcdef0');
  });

  it('mergePullRequest sends squash:true when method is squash', async () => {
    const fetchMock = stubFetch(
      jsonResponse({ state: 'merged', merge_commit_sha: 'sha' }),
    );
    await provider.mergePullRequest(repo, 42, { method: 'squash' });
    const body = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string);
    expect(body.squash).toBe(true);
  });

  it('commentOnPullRequest sends to /merge_requests/{iid}/notes', async () => {
    const fetchMock = stubFetch(jsonResponse({}));
    const r = await provider.commentOnPullRequest(repo, 42, 'a comment');
    expect(r).toBeUndefined();
    expect(fetchMock.mock.calls[0]?.[0]).toContain(
      '/projects/test-org%2Ftest-repo/merge_requests/42/notes',
    );
  });

  it('closePullRequest sends a state_event=close PUT', async () => {
    const fetchMock = stubFetch(jsonResponse({}));
    await provider.closePullRequest(repo, 42);
    const call = fetchMock.mock.calls[0];
    expect(call?.[0]).toContain('/merge_requests/42');
    expect(call?.[1]).toMatchObject({ method: 'PUT' });
    expect(JSON.parse(call?.[1]?.body as string)).toEqual({ state_event: 'close' });
  });

  it('listOpenPullRequests returns valid PullRequests with iid as number', async () => {
    stubFetch(
      jsonResponse([
        {
          iid: 1,
          web_url: 'https://gitlab.example.com/o/r/-/merge_requests/1',
          source_branch: 'a',
          state: 'opened',
        },
        {
          iid: 2,
          web_url: 'https://gitlab.example.com/o/r/-/merge_requests/2',
          source_branch: 'b',
          state: 'opened',
        },
      ]),
    );
    const list = await provider.listOpenPullRequests(repo);
    expect(list.length).toBe(2);
    for (const pr of list) {
      expectValidPullRequest(pr);
      expect(pr.state).toBe('open');
    }
    expect(list[0]?.number).toBe(1);
    expect(list[1]?.branch).toBe('b');
  });

  it('getDefaultBranch returns the branch string', async () => {
    stubFetch(jsonResponse({ default_branch: 'main' }));
    const b = await provider.getDefaultBranch(repo);
    expect(b).toBe('main');
  });
});

describe('GitLabProvider — conformance (file fetch)', () => {
  it('getFileAt returns base64 content for a file', async () => {
    stubFetch(jsonResponse({ encoding: 'base64', content: 'aGVsbG8=' }));
    const r = await provider.getFileAt(repo, 'main', 'README.md');
    expect(r.contentBase64).toBe('aGVsbG8=');
  });

  it('getFileAt rejects when encoding is not base64', async () => {
    stubFetch(jsonResponse({ encoding: 'text', content: 'hello' }));
    await expect(provider.getFileAt(repo, 'main', 'README.md')).rejects.toThrow(
      /not a file or unsupported encoding/,
    );
  });

  it('getPullRequestFiles parses the changes payload', async () => {
    stubFetch(
      jsonResponse({
        changes: [
          {
            new_path: 'a.ts',
            old_path: 'a.ts',
            new_file: false,
            deleted_file: false,
            renamed_file: false,
            diff: '@@ -1,2 +1,4 @@\n line\n+added\n+added2\n line\n',
          },
          {
            new_path: 'b.ts',
            old_path: 'old.ts',
            new_file: false,
            deleted_file: false,
            renamed_file: true,
            diff: '',
          },
        ],
      }),
    );
    const files = await provider.getPullRequestFiles(repo, 42);
    expect(files.length).toBe(2);
    for (const f of files) expectValidPullRequestFile(f);
    expect(files[0]?.status).toBe('modified');
    expect(files[0]?.additions).toBe(2);
    expect(files[1]?.status).toBe('renamed');
    expect(files[1]?.oldPath).toBe('old.ts');
  });

  it('getPullRequestFiles maps deleted_file to removed', async () => {
    stubFetch(
      jsonResponse({
        changes: [
          { new_path: 'gone.ts', old_path: 'gone.ts', deleted_file: true, diff: '' },
        ],
      }),
    );
    const files = await provider.getPullRequestFiles(repo, 42);
    expect(files[0]?.status).toBe('removed');
  });
});

describe('GitLabProvider — conformance (webhooks)', () => {
  it('verifyWebhookSignature accepts a matching shared-secret token', async () => {
    const ok = await provider.verifyWebhookSignature(
      { 'x-gitlab-token': 'shh' },
      Buffer.from('{}'),
      'shh',
    );
    expect(ok).toBe(true);
  });

  it('verifyWebhookSignature rejects a mismatched token', async () => {
    const ok = await provider.verifyWebhookSignature(
      { 'x-gitlab-token': 'wrong' },
      Buffer.from('{}'),
      'shh',
    );
    expect(ok).toBe(false);
  });

  it('verifyWebhookSignature rejects when the header is missing', async () => {
    const ok = await provider.verifyWebhookSignature({}, Buffer.from('{}'), 'shh');
    expect(ok).toBe(false);
  });

  it('parseWebhookEvent extracts Merge Request Hook → pull_request', () => {
    const body = Buffer.from(
      JSON.stringify({
        object_attributes: { action: 'open', iid: 7 },
        project: { path_with_namespace: 'o/r' },
      }),
    );
    const e = provider.parseWebhookEvent({ 'x-gitlab-event': 'Merge Request Hook' }, body);
    expectValidVcsEvent(e);
    expect(e.kind).toBe('pull_request');
    if (e.kind === 'pull_request') {
      expect(e.action).toBe('open');
      expect(e.prNumber).toBe(7);
      expect(e.repoFullName).toBe('o/r');
    }
  });

  it('parseWebhookEvent maps Pipeline Hook to workflow_run', () => {
    const body = Buffer.from(
      JSON.stringify({
        object_attributes: { id: 12345, status: 'success' },
        project: { path_with_namespace: 'o/r' },
      }),
    );
    const e = provider.parseWebhookEvent({ 'x-gitlab-event': 'Pipeline Hook' }, body);
    expectValidVcsEvent(e);
    expect(e.kind).toBe('workflow_run');
    if (e.kind === 'workflow_run') {
      expect(e.runId).toBe(12345);
      expect(e.action).toBe('success');
    }
  });

  it('parseWebhookEvent falls back to unknown for unrecognized events', () => {
    const e = provider.parseWebhookEvent(
      { 'x-gitlab-event': 'Note Hook' },
      Buffer.from('{}'),
    );
    expect(e.kind).toBe('unknown');
  });
});

describe('GitLabProvider — surface', () => {
  it('exposes id "gitlab"', () => {
    expect(provider.id).toBe('gitlab');
  });

  it('rejects an invalid baseUrl at construction time', () => {
    expect(() => new GitLabProvider({ token: 't', baseUrl: 'not a url' })).toThrow(
      /invalid baseUrl/,
    );
  });

  it('defaults baseUrl to gitlab.com when not provided', async () => {
    const gl = new GitLabProvider({ token: 't' });
    const fetchMock = stubFetch(jsonResponse({ default_branch: 'main' }));
    await gl.getDefaultBranch(repo);
    expect(fetchMock.mock.calls[0]?.[0]).toMatch(/^https:\/\/gitlab\.com\/api\/v4\//);
  });

  it('throws on a non-2xx HTTP response', async () => {
    stubFetch(new Response('boom', { status: 500 }));
    await expect(provider.getDefaultBranch(repo)).rejects.toThrow(/gitlab 500/);
  });
});

void crypto;
