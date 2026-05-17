/**
 * Helpers for reading `ConnectedRepo` correctly in the presence of the
 * `basePrBranch` field (#469).
 *
 * `defaultBranch` records what GitHub reports as the repo's default
 * branch (a fact). `basePrBranch` records which branch mergecrew should
 * open PRs / fork workspaces / build releases against (a choice).
 *
 * For trunk-based teams those collapse — `basePrBranch` is NULL and
 * everything coalesces back to `defaultBranch`. For branch-per-env
 * teams (developer → dev, qa → stage, main → prod), the user points
 * `basePrBranch` at their integration branch.
 *
 * Use `effectiveBaseBranch()` anywhere code currently reads
 * `repo.defaultBranch` AND the intent is "the integration branch to
 * work against" — PR base, workspace clone ref, blast-radius diff
 * base, agent's branch-off point.
 */
export function effectiveBaseBranch(repo: {
  basePrBranch?: string | null;
  defaultBranch: string;
}): string {
  return repo.basePrBranch?.trim() || repo.defaultBranch;
}
