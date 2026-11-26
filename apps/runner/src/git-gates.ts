import {
  RUN_BRANCH_PREFIX,
  assertPushableBranch,
  gitAddedLines,
  gitDiffNumstat,
  type NumstatEntry,
} from '@mergecrew/adapters-vcs';
import { touchesDeploySensitivePaths } from '@mergecrew/agent-runtime';
import { scanText, scanValue, type SecretFinding } from '@mergecrew/skills';

/**
 * Runner-side gates around the two moments agent output leaves the
 * platform with real consequences: pushing a changeset branch and
 * auto-dispatching a dev deploy from it. All git here runs through the
 * hardened safe-git wrapper.
 */

/**
 * Per-file diff stats of `<branch>` vs `origin/<base>`. Best-effort for
 * the blast-radius gate (returns [] on failure, as before); deploy
 * gating uses `checkDeployAllowed`, which fails closed instead.
 */
export async function getLocalBranchStats(
  workspacePath: string,
  branch: string,
  baseBranch: string,
): Promise<NumstatEntry[]> {
  try {
    return await gitDiffNumstat(workspacePath, baseBranch, branch);
  } catch {
    return [];
  }
}

export type DeployGateResult =
  | { ok: true }
  | { ok: false; reason: 'not_run_branch' | 'diff_unavailable' | 'sensitive_paths'; paths?: string[]; message: string };

/**
 * May the runner auto-dispatch a dev deploy from `branch`? Refuses
 * anything but a `mergecrew/` branch distinct from the base, and any
 * changeset whose diff touches CI / deploy workflows, Dockerfiles or
 * IaC (those would run attacker-chosen code with the tenant's deploy
 * secrets). A human can still deploy such a branch manually after
 * review. Fails closed when the diff cannot be computed.
 */
export async function checkDeployAllowed(opts: {
  workspacePath: string;
  branch: string;
  baseBranch: string;
}): Promise<DeployGateResult> {
  try {
    assertPushableBranch(opts.branch, [opts.baseBranch]);
  } catch (err) {
    return { ok: false, reason: 'not_run_branch', message: (err as Error).message };
  }
  let stats: NumstatEntry[];
  try {
    stats = await gitDiffNumstat(opts.workspacePath, opts.baseBranch, opts.branch);
  } catch (err) {
    return { ok: false, reason: 'diff_unavailable', message: (err as Error).message.slice(0, 300) };
  }
  const sensitive = touchesDeploySensitivePaths(stats.map((s) => s.path));
  if (sensitive.length > 0) {
    return {
      ok: false,
      reason: 'sensitive_paths',
      paths: sensitive,
      message: `changeset touches CI / deploy / infra paths (${sensitive.slice(0, 5).join(', ')}); auto-deploy requires a human`,
    };
  }
  return { ok: true };
}

/**
 * Outbound secret scan before a changeset is pushed and its PR opened:
 * PR title + body, the branch name, and every added line of the diff.
 */
export async function scanChangesetBeforePush(opts: {
  workspacePath: string;
  branch: string;
  baseBranch: string;
  title: string;
  body: string;
}): Promise<SecretFinding[]> {
  const findings: SecretFinding[] = [
    ...scanValue({ title: opts.title, body: opts.body, branch: opts.branch }, 'pr'),
  ];
  let added: string;
  try {
    added = await gitAddedLines(opts.workspacePath, opts.baseBranch, opts.branch);
  } catch (err) {
    // Fail closed: if we cannot see the diff we cannot vouch for it.
    return [...findings, { kind: 'diff_unavailable', location: 'diff' }];
  }
  findings.push(...scanText(added, 'diff'));
  return findings;
}

export { RUN_BRANCH_PREFIX };
