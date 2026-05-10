/**
 * Behavioral conformance helpers for `VcsProvider` adapters (V2.3, #27).
 *
 * Each adapter wraps a different vendor (GitHub via @octokit/rest,
 * GitLab via @gitbeaker/rest, Gitea via its REST API, …) but must
 * satisfy the same runtime contract — return the right `PullRequest`
 * shape, parse webhook events into a valid `VcsEvent`, etc. These
 * helpers exist so a per-adapter test file (`github.test.ts`,
 * `gitlab.test.ts`, …) can focus on the SDK-level mocking and reuse
 * the assertions.
 *
 * The reference test is `github.test.ts`; new-adapter authors copy
 * that file, swap the mocks for their vendor's library / HTTP shape,
 * and the helpers below catch contract violations the same way.
 *
 * Note: git-shell methods (`cloneIntoWorkspace`, `createBranch`,
 * `commit`, `push`, `fetchUpdate`) are intentionally not part of the
 * conformance suite. They wrap `git` under `execa`; mocking that
 * subprocess interface adds noise without much signal. The dogfood
 * smoke (`apps/dogfood-smoke`) exercises them end-to-end against a
 * real test repo.
 */

import { expect } from 'vitest';
import type {
  ConnectedRepoRef,
  MergeResult,
  PullRequest,
  PullRequestFile,
  VcsEvent,
} from '../src/types.js';

const VALID_PR_STATES = ['open', 'closed', 'merged'] as const;
const VALID_FILE_STATUSES = ['added', 'modified', 'removed', 'renamed'] as const;
const VALID_EVENT_KINDS = [
  'pull_request',
  'workflow_run',
  'check_run',
  'installation',
  'unknown',
] as const;

export function makeRepoRef(overrides: Partial<ConnectedRepoRef> = {}): ConnectedRepoRef {
  return {
    installationId: '12345',
    repoFullName: 'test-org/test-repo',
    defaultBranch: 'main',
    ...overrides,
  };
}

export function expectValidPullRequest(pr: PullRequest): void {
  expect(typeof pr.number).toBe('number');
  expect(pr.number).toBeGreaterThan(0);
  expect(typeof pr.url).toBe('string');
  expect(pr.url.length).toBeGreaterThan(0);
  expect(typeof pr.branch).toBe('string');
  expect(pr.branch.length).toBeGreaterThan(0);
  expect(VALID_PR_STATES).toContain(pr.state);
}

export function expectValidMergeResult(r: MergeResult): void {
  expect(typeof r.sha).toBe('string');
  expect(r.sha.length).toBeGreaterThan(0);
  expect(typeof r.merged).toBe('boolean');
}

export function expectValidPullRequestFile(f: PullRequestFile): void {
  expect(typeof f.path).toBe('string');
  expect(f.path.length).toBeGreaterThan(0);
  expect(VALID_FILE_STATUSES).toContain(f.status);
  expect(typeof f.additions).toBe('number');
  expect(typeof f.deletions).toBe('number');
  expect(Array.isArray(f.hunks)).toBe(true);
  // oldPath is null for non-renames.
  expect(f.oldPath === null || typeof f.oldPath === 'string').toBe(true);
}

export function expectValidVcsEvent(e: VcsEvent): void {
  expect(VALID_EVENT_KINDS).toContain(e.kind);
  // Every event preserves the raw payload so the orchestrator can
  // log / re-process if the discriminator missed something.
  expect(e.raw).toBeDefined();
}
