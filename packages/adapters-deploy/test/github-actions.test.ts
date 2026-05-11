/**
 * Conformance test for the GitHub Actions deploy adapter (V2.2 follow-up, #198).
 *
 * Mocks @octokit/rest + @octokit/auth-app at the module seam (same shape
 * as packages/adapters-vcs/test/github.test.ts) instead of stubbing
 * fetch, since the adapter goes through Octokit. Validates the
 * DeployProvider contract via the helpers in `./conformance.ts`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const kitMock = {
  actions: {
    createWorkflowDispatch: vi.fn(),
    listWorkflowRuns: vi.fn(),
    listJobsForWorkflowRun: vi.fn(),
    getWorkflowRun: vi.fn(),
  },
};

vi.mock('@octokit/auth-app', () => ({
  createAppAuth: () => async () => ({ token: 'gh_test_token' }),
}));

vi.mock('@octokit/rest', () => ({
  Octokit: vi.fn().mockImplementation(() => kitMock),
}));

import { GitHubActionsProvider } from '../src/github-actions.js';
import {
  expectValidHandle,
  expectValidStatus,
  makeTarget,
} from './conformance.js';

const target = makeTarget('github-actions', {
  installationId: '12345',
  repoFullName: 'acme/web',
  workflowFilename: 'deploy-dev.yml',
  inputsTemplate: { branch: '${ref.branch}' },
  urlResolution: 'pattern',
  urlPattern: 'https://${branch}.preview.example.com',
});

let provider: GitHubActionsProvider;

beforeEach(() => {
  provider = new GitHubActionsProvider({ appId: '1', privateKey: 'TEST' });
  for (const fn of Object.values(kitMock.actions)) {
    if (typeof fn === 'function' && 'mockReset' in fn) (fn as any).mockReset();
  }
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('GitHubActionsProvider — conformance (trigger + status)', () => {
  it('triggerDeploy returns a well-shaped DeployHandle', async () => {
    kitMock.actions.createWorkflowDispatch.mockResolvedValueOnce({ data: {} });
    // findRunByCorrelation: returns the most recent run as a fallback if
    // no job-name match. We keep the recent-run heuristic happy by giving
    // it one matching entry.
    kitMock.actions.listWorkflowRuns.mockResolvedValueOnce({
      data: {
        workflow_runs: [
          {
            id: 999,
            head_branch: 'main',
            created_at: new Date().toISOString(),
          },
        ],
      },
    });
    kitMock.actions.listJobsForWorkflowRun.mockResolvedValueOnce({
      data: {
        jobs: [{ name: 'mergecrew_correlation:abc', status: 'queued' }],
      },
    });

    const handle = await provider.triggerDeploy(target, {
      ref: 'sha123',
      branch: 'main',
      correlationId: 'abc',
    });
    expectValidHandle(handle, { targetId: target.id, correlationId: 'abc' });
    expect(handle.externalRunId).toBe('999');

    // The dispatch call passes the inputs template + correlation id.
    expect(kitMock.actions.createWorkflowDispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: 'acme',
        repo: 'web',
        workflow_id: 'deploy-dev.yml',
        ref: 'main',
      }),
    );
  });

  it('getStatus maps every documented run conclusion to a valid DeployStatus', async () => {
    // getStatus needs a registered route; rememberRoute is called by the
    // runner immediately after triggerDeploy in production. We register
    // directly here to keep the test focused on status mapping.
    GitHubActionsProvider.rememberRoute(
      '999',
      'acme/web',
      Promise.resolve(kitMock as any),
    );

    const cases: Array<{
      runStatus: string;
      conclusion: string | null;
      expectedKind: string;
    }> = [
      { runStatus: 'queued', conclusion: null, expectedKind: 'in_progress' },
      { runStatus: 'in_progress', conclusion: null, expectedKind: 'in_progress' },
      { runStatus: 'completed', conclusion: 'success', expectedKind: 'success' },
      { runStatus: 'completed', conclusion: 'failure', expectedKind: 'failed' },
      { runStatus: 'completed', conclusion: 'cancelled', expectedKind: 'cancelled' },
      { runStatus: 'completed', conclusion: 'skipped', expectedKind: 'cancelled' },
      { runStatus: 'completed', conclusion: 'timed_out', expectedKind: 'failed' },
    ];

    for (const c of cases) {
      kitMock.actions.getWorkflowRun.mockResolvedValueOnce({
        data: {
          status: c.runStatus,
          conclusion: c.conclusion,
          updated_at: '2026-05-10T00:00:00Z',
        },
      });
      kitMock.actions.listJobsForWorkflowRun.mockResolvedValueOnce({
        data: { jobs: [{ name: 'build', status: c.runStatus, conclusion: c.conclusion }] },
      });
      const s = await provider.getStatus({
        externalRunId: '999',
        targetId: target.id,
        correlationId: 'c',
      });
      expect(s.kind, `runStatus=${c.runStatus} conclusion=${c.conclusion}`).toBe(c.expectedKind);
      expectValidStatus(s);
    }
  });

  it('getStatus returns "queued" when the externalRunId has no registered route', async () => {
    const s = await provider.getStatus({
      externalRunId: 'never-registered',
      targetId: target.id,
      correlationId: 'c',
    });
    expect(s.kind).toBe('queued');
  });
});

describe('GitHubActionsProvider — conformance (URL resolution + logs + rollback)', () => {
  it('resolveUrlForRef returns the configured pattern with substitutions', async () => {
    const url = await provider.resolveUrlForRef(target, 'feature-x');
    expect(url).toBe('https://feature-x.preview.example.com');
  });

  it('resolveUrlForRef returns the fixed URL when configured that way', async () => {
    const fixedTarget = makeTarget('github-actions', {
      installationId: '12345',
      repoFullName: 'acme/web',
      workflowFilename: 'deploy-prod.yml',
      inputsTemplate: {},
      urlResolution: 'fixed',
      urlFixed: 'https://prod.example.com',
    });
    const url = await provider.resolveUrlForRef(fixedTarget, 'sha');
    expect(url).toBe('https://prod.example.com');
  });

  it('resolveUrlForRef returns null for workflow_output mode in V1', async () => {
    const woTarget = makeTarget('github-actions', {
      installationId: '12345',
      repoFullName: 'acme/web',
      workflowFilename: 'deploy-prod.yml',
      inputsTemplate: {},
      urlResolution: 'workflow_output',
    });
    const url = await provider.resolveUrlForRef(woTarget, 'sha');
    expect(url).toBeNull();
  });

  it('fetchLogs returns LogChunks summarized from job conclusions', async () => {
    GitHubActionsProvider.rememberRoute(
      '888',
      'acme/web',
      Promise.resolve(kitMock as any),
    );
    kitMock.actions.getWorkflowRun.mockResolvedValueOnce({
      data: { status: 'completed', conclusion: 'success', updated_at: '2026-05-10T00:00:00Z' },
    });
    kitMock.actions.listJobsForWorkflowRun.mockResolvedValueOnce({
      data: {
        jobs: [
          { name: 'build', status: 'completed', conclusion: 'success', started_at: '2026-05-10T00:00:00Z', completed_at: '2026-05-10T00:01:00Z' },
          { name: 'deploy', status: 'completed', conclusion: 'success', started_at: '2026-05-10T00:01:00Z', completed_at: '2026-05-10T00:02:00Z' },
        ],
      },
    });
    const logs = await provider.fetchLogs(
      { externalRunId: '888', targetId: target.id, correlationId: 'c' },
      { tailLines: 10 },
    );
    expect(Array.isArray(logs)).toBe(true);
    expect(logs.length).toBe(2);
    expect(logs[0]?.line).toContain('build');
    expect(logs[1]?.line).toContain('deploy');
  });
});

describe('GitHubActionsProvider — observe mode (#259)', () => {
  const observeTarget = makeTarget('github-actions', {
    installationId: '12345',
    repoFullName: 'acme/web',
    workflowFilename: 'deploy-dev.yml',
    inputsTemplate: {},
    urlResolution: 'pattern',
    urlPattern: 'https://${branch}.preview.example.com',
    triggerMode: 'observe',
    observeFindTimeoutMs: 100,
  });

  it('returns a handle bound to the operator-initiated run id without dispatching', async () => {
    kitMock.actions.listWorkflowRuns.mockResolvedValueOnce({
      data: {
        workflow_runs: [
          { id: 4242, head_branch: 'feature-x', created_at: new Date().toISOString() },
        ],
      },
    });

    const handle = await provider.triggerDeploy(observeTarget, {
      ref: 'sha-abc',
      branch: 'feature-x',
      correlationId: 'cid-obs',
    });

    expectValidHandle(handle, { targetId: observeTarget.id, correlationId: 'cid-obs' });
    expect(handle.externalRunId).toBe('4242');
    expect(kitMock.actions.createWorkflowDispatch).not.toHaveBeenCalled();
  });

  it('throws a clear error if no run materializes within the timeout', async () => {
    kitMock.actions.listWorkflowRuns.mockResolvedValue({ data: { workflow_runs: [] } });

    await expect(
      provider.triggerDeploy(observeTarget, {
        ref: 'sha-abc',
        branch: 'feature-x',
        correlationId: 'cid-obs',
      }),
    ).rejects.toThrow(/no workflow run for deploy-dev\.yml on branch feature-x/);
    expect(kitMock.actions.createWorkflowDispatch).not.toHaveBeenCalled();
  });

  it('ignores stale runs from another branch even if they are recent', async () => {
    kitMock.actions.listWorkflowRuns.mockResolvedValue({
      data: {
        workflow_runs: [
          { id: 1, head_branch: 'main', created_at: new Date().toISOString() },
        ],
      },
    });

    await expect(
      provider.triggerDeploy(observeTarget, {
        ref: 'sha-abc',
        branch: 'feature-x',
        correlationId: 'cid-obs',
      }),
    ).rejects.toThrow(/no workflow run for deploy-dev\.yml on branch feature-x/);
  });
});

describe('GitHubActionsProvider — surface', () => {
  it('exposes id "github-actions"', () => {
    expect(provider.id).toBe('github-actions');
  });
});
