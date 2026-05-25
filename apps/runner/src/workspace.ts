import path from 'node:path';
import { promises as fs } from 'node:fs';
import type { Logger } from 'pino';
import type { VcsProvider } from '@mergecrew/adapters-vcs';
import type { SandboxDriver, SandboxHandle } from '@mergecrew/sandbox-driver';

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

/**
 * Driver-mediated workspace bootstrap (V2.ag / ADR-0009 step 4).
 *
 * Same contract as `bootstrapWorkspace` but runs the git clone INSIDE
 * the sandbox via `driver.exec` instead of on the supervisor's host
 * filesystem. Required for the BYO agent path (`HttpSandboxDriver`)
 * where the supervisor's host workspace and the agent's sandbox
 * workspace are different machines.
 *
 * Works for instance-builtin too (driver.exec inside the local docker
 * container ends up populating the host-mounted workspace), but we
 * keep the existing host-side `bootstrapWorkspace` as the default
 * there because it's well-tested and shaves one round-trip.
 *
 * The supervisor mints a 1-hour installation token via
 * `vcs.getInstallationToken` and bakes it into the clone URL. Token
 * is logged-scrubbed (replaced with `***`) so the runner logs don't
 * leak it.
 */
export async function bootstrapWorkspaceViaDriver(args: {
  driver: SandboxDriver;
  handle: SandboxHandle;
  vcs: VcsProvider | undefined;
  fetchConnectedRepo: () => Promise<ConnectedRepoForBootstrap | null>;
  logger: Logger;
}): Promise<BootstrapResult> {
  const { driver, handle, vcs, fetchConnectedRepo, logger } = args;

  // Idempotency: if `.git` already exists, the sandbox has been
  // populated by a prior step in the same run.
  const gitCheck = await driver
    .exec(handle, { cmd: 'test', args: ['-d', '.git'] })
    .catch(() => ({ exitCode: 1, stdout: '', stderr: '', timedOut: false }));
  if (gitCheck.exitCode === 0) return { kind: 'reused' };

  if (!vcs) {
    return {
      kind: 'failed',
      reason: 'github_app_not_configured',
      message:
        'GitHub App credentials are not configured on the supervisor (set GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY)',
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

  let token: string;
  try {
    token = await vcs.getInstallationToken(repo.installationId);
  } catch (err) {
    return {
      kind: 'failed',
      reason: 'clone_failed',
      message:
        `failed to mint installation token for ${vcs.id}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  // Auth URL for git over HTTPS. GitHub accepts `x-access-token:<token>`
  // as the basic-auth user/password pair.
  const repoUrl = `https://x-access-token:${token}@github.com/${repo.repoFullName}.git`;

  // Clone into the current workspace dir. `--depth 50` matches the
  // host-side bootstrap; `--branch` pins to the default branch so the
  // clone tree starts at the right ref.
  const cloneResult = await driver
    .exec(handle, {
      cmd: 'git',
      args: ['clone', '--depth', '50', '--branch', repo.defaultBranch, repoUrl, '.'],
      // Per-call timeout. Most clones land in <60s; allow 5min for
      // large repos. The hard supervisor ceiling on a sandbox op is
      // 15min (server-side), so this is well inside that.
      timeoutMs: 5 * 60_000,
    })
    .catch((err: unknown) => ({
      exitCode: 1,
      stdout: '',
      stderr: err instanceof Error ? err.message : String(err),
      timedOut: false,
    }));

  if (cloneResult.exitCode !== 0) {
    return {
      kind: 'failed',
      reason: 'clone_failed',
      // Scrub the token before surfacing the error.
      message: cloneResult.stderr.replace(token, '***').slice(0, 500),
    };
  }
  logger.info(
    { repoFullName: repo.repoFullName, branch: repo.defaultBranch },
    'workspace bootstrap (via driver): cloned',
  );
  return { kind: 'cloned', branch: repo.defaultBranch };
}
