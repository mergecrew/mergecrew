import path from 'node:path';
import { promises as fs } from 'node:fs';
import type { Logger } from 'pino';
import type { VcsProvider } from '@mergecrew/adapters-vcs';

/**
 * Root directory for per-run workspaces. In prod set to the container's
 * writable mount (e.g. /var/mergecrew/work); in dev falls back to a
 * tmp subdirectory.
 *
 * Centralized here because step.ts (writes) and workspace-cleanup
 * (deletes) must agree on the same path scheme.
 */
export function workspaceRoot(): string {
  return process.env.RUNNER_WORKSPACE_ROOT ?? path.join(process.env.TMPDIR ?? '/tmp', 'mergecrew-work');
}

export function workspacePathForRun(runId: string): string {
  return path.join(workspaceRoot(), runId);
}

/**
 * Run-terminal workspace cleanup. Invoked from a BullMQ worker on the
 * `runner.workspace-cleanup` queue; producers are orchestrator.completeRun
 * (status='done') and api.run.cancel (status='cancelled').
 *
 * Best-effort: a failed rm logs but doesn't throw. Leaving a workspace
 * around wastes disk but never blocks the run's terminal state — masking
 * the run as "stuck cleaning up" would be worse than the leak.
 */
export async function cleanupWorkspace(args: {
  runId: string;
  logger: Logger;
}): Promise<void> {
  const { runId, logger } = args;
  const dir = workspacePathForRun(runId);
  try {
    await fs.rm(dir, { recursive: true, force: true });
    logger.info({ runId, dir }, 'workspace-cleanup: removed');
  } catch (err: any) {
    logger.warn(
      { runId, dir, err: err?.message ?? err },
      'workspace-cleanup: rm failed; workspace may leak until next sweep',
    );
  }
}

export const WORKSPACE_CLEANUP_QUEUE = 'runner.workspace-cleanup';

/**
 * Subset of the ConnectedRepo row we need to bootstrap a workspace.
 * Decoupled from the Prisma row type so tests can stub it freely.
 */
export interface ConnectedRepoForBootstrap {
  installationId: string;
  repoId?: string | null;
  repoFullName: string;
  defaultBranch: string;
}

export type BootstrapResult =
  | { kind: 'cloned'; branch: string }
  | { kind: 'reused' }
  | { kind: 'failed'; reason: 'no_connected_repo' | 'github_app_not_configured' | 'clone_failed'; message: string };

/**
 * Idempotently populate a per-run workspace with a clone of the connected
 * repo. Called once per run from the first step that lands; subsequent
 * steps see `.git` and short-circuit to `kind: 'reused'`.
 *
 * Pure with respect to side-effects outside the workspace + vcs: returns
 * a result the caller translates into eventlog emissions / step-row
 * updates. That keeps this function unit-testable against an in-memory
 * vcs stub without a DB or eventlog.
 */
export async function bootstrapWorkspace(args: {
  workspacePath: string;
  vcs: VcsProvider | undefined;
  fetchConnectedRepo: () => Promise<ConnectedRepoForBootstrap | null>;
  logger: Logger;
}): Promise<BootstrapResult> {
  const { workspacePath, vcs, fetchConnectedRepo, logger } = args;
  const gitDir = path.join(workspacePath, '.git');
  const alreadyCloned = await fs
    .access(gitDir)
    .then(() => true)
    .catch(() => false);
  if (alreadyCloned) return { kind: 'reused' };

  if (!vcs) {
    return {
      kind: 'failed',
      reason: 'github_app_not_configured',
      message:
        'GitHub App credentials are not configured on this server (set GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY in .env) — see docs/03-infrastructure/05-operator-runbook.md',
    };
  }
  const repo = await fetchConnectedRepo();
  if (!repo) {
    return {
      kind: 'failed',
      reason: 'no_connected_repo',
      message:
        'project has no connected repository — connect one under Project Settings → Repository before running',
    };
  }

  // Wipe + recreate to handle partial state left over from a previous
  // failed bootstrap (`git clone` refuses to write into a non-empty dir).
  await fs.rm(workspacePath, { recursive: true, force: true });
  await fs.mkdir(workspacePath, { recursive: true, mode: 0o700 });

  try {
    await vcs.cloneIntoWorkspace(
      {
        installationId: repo.installationId,
        repoId: repo.repoId ?? undefined,
        repoFullName: repo.repoFullName,
        defaultBranch: repo.defaultBranch,
      },
      repo.defaultBranch,
      workspacePath,
    );
    logger.info(
      { workspacePath, repoFullName: repo.repoFullName, branch: repo.defaultBranch },
      'workspace bootstrap: cloned',
    );
    return { kind: 'cloned', branch: repo.defaultBranch };
  } catch (err: any) {
    return {
      kind: 'failed',
      reason: 'clone_failed',
      message: err?.message ?? String(err),
    };
  }
}
