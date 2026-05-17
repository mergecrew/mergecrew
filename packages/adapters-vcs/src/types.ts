export interface ConnectedRepoRef {
  installationId: string;
  repoId?: string;
  repoFullName: string;
  defaultBranch: string;
}

export interface PullRequestOpts {
  head: string;
  base: string;
  title: string;
  body: string;
  draft?: boolean;
}

export interface PullRequest {
  number: number;
  url: string;
  branch: string;
  state: 'open' | 'closed' | 'merged';
}

export interface MergeOpts {
  method: 'merge' | 'squash' | 'rebase';
  commitTitle?: string;
  commitMessage?: string;
}

export interface MergeResult {
  sha: string;
  merged: boolean;
}

export type FileChangeStatus = 'added' | 'modified' | 'removed' | 'renamed';

export interface DiffLine {
  type: 'add' | 'del' | 'context';
  /** 1-indexed line number in the pre-image (null for added lines). */
  oldLine: number | null;
  /** 1-indexed line number in the post-image (null for deleted lines). */
  newLine: number | null;
  content: string;
}

export interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  header: string;
  lines: DiffLine[];
}

/** Optional inline review comment (#419, V2.al). */
export interface InlineReviewComment {
  /** Repository-relative path. */
  path: string;
  /** 1-indexed line number in the diff's post-image. */
  line: number;
  /** Comment body, plain text or markdown. */
  body: string;
}

/** Arguments for VcsProvider.postReview (#419, V2.al). */
export interface PostReviewOpts {
  /** Review event verdict. Maps to GitHub's APPROVE / REQUEST_CHANGES / COMMENT. */
  event: 'approve' | 'request_changes' | 'comment';
  /** Review body, plain text or markdown. */
  body: string;
  /** Optional inline comments. Empty/unset is fine. */
  comments?: InlineReviewComment[];
}

/**
 * Snapshot of a merged PR needed by the promote engine (#471) — it
 * needs the merge commit SHA to cherry-pick onto the release branch
 * and the parent count to pick between `git cherry-pick` and `git
 * cherry-pick -m 1`. Also used by drop/revert to open a revert PR.
 */
export interface MergedPullRequest {
  number: number;
  title: string;
  body: string | null;
  url: string;
  /** Commit on the base branch after the PR merged. Null for unmerged PRs. */
  mergeCommitSha: string | null;
  mergedAt: string | null;
  /**
   * True when the merge commit has 2+ parents (true merge); false for
   * squash- or rebase-merged PRs (single-parent commit). Cherry-pick of
   * the former needs `-m 1` to pick the first-parent diff.
   */
  isMergeCommit: boolean;
  /** PR head branch ref, used by drop to derive a slug. */
  headBranch: string;
}

/**
 * Inputs to dispatch a `workflow_dispatch` event on a GitHub Actions
 * workflow file (#471). Used by `manual_workflow` PromotionStrategy
 * after the release branch is built.
 */
export interface DispatchWorkflowOpts {
  workflowFilename: string;
  /** Ref the workflow runs against — usually the release branch. */
  ref: string;
  inputs?: Record<string, string>;
}

export interface PullRequestFile {
  path: string;
  /** Source path when the file was renamed; null otherwise. */
  oldPath: string | null;
  status: FileChangeStatus;
  additions: number;
  deletions: number;
  /** Parsed hunks. Empty array for binary or rename-only files. */
  hunks: DiffHunk[];
}

export type VcsEvent =
  | { kind: 'pull_request'; action: string; prNumber: number; repoFullName: string; raw: unknown }
  | { kind: 'workflow_run'; action: string; runId: number; repoFullName: string; raw: unknown }
  | { kind: 'check_run'; action: string; repoFullName: string; raw: unknown }
  | { kind: 'installation'; action: string; installationId: string; raw: unknown }
  | { kind: 'unknown'; raw: unknown };

export interface VcsProvider {
  readonly id: 'github' | 'gitlab' | 'gitea';

  cloneIntoWorkspace(repo: ConnectedRepoRef, ref: string, dest: string): Promise<void>;
  fetchUpdate(workspace: string, ref: string): Promise<void>;

  createBranch(workspace: string, name: string, fromRef: string): Promise<void>;
  commit(
    workspace: string,
    opts: { message: string; authorName: string; authorEmail: string; signoff?: boolean },
  ): Promise<string>;
  push(workspace: string, branch: string): Promise<void>;

  openPullRequest(repo: ConnectedRepoRef, opts: PullRequestOpts): Promise<PullRequest>;
  commentOnPullRequest(repo: ConnectedRepoRef, prNumber: number, body: string): Promise<void>;
  /**
   * Post a structured PR review (#419, V2.al). Used by the runner to
   * surface the reviewer agent's verdict natively in GitHub so human
   * reviewers see it in the PR's Reviews tab rather than only in the
   * mergecrew UI. Adapters that don't support PR reviews (Gitea,
   * GitLab today) log a warning and resolve. The runner treats the
   * call as best-effort and never blocks the run on a failure here.
   */
  postReview(
    repo: ConnectedRepoRef,
    prNumber: number,
    opts: PostReviewOpts,
  ): Promise<void>;
  /**
   * Flip a draft PR to ready-for-review (#419, V2.al). Adapters that
   * don't support this (Gitea, GitLab today) log a warning. Called by
   * the runner only after the reviewer agent verdict is 'approve'.
   */
  markReadyForReview(repo: ConnectedRepoRef, prNumber: number): Promise<void>;
  mergePullRequest(repo: ConnectedRepoRef, prNumber: number, opts: MergeOpts): Promise<MergeResult>;
  revertPullRequest(repo: ConnectedRepoRef, prNumber: number): Promise<{ revertPrNumber: number }>;
  closePullRequest(repo: ConnectedRepoRef, prNumber: number): Promise<void>;

  listOpenPullRequests(repo: ConnectedRepoRef): Promise<PullRequest[]>;
  getDefaultBranch(repo: ConnectedRepoRef): Promise<string>;
  getFileAt(repo: ConnectedRepoRef, ref: string, path: string): Promise<{ contentBase64: string }>;
  getPullRequestFiles(repo: ConnectedRepoRef, prNumber: number): Promise<PullRequestFile[]>;
  /**
   * Fetch the bits of a merged PR the promote engine (#471) needs.
   * Returns `mergeCommitSha = null` if the PR isn't merged yet.
   */
  getMergedPullRequest(repo: ConnectedRepoRef, prNumber: number): Promise<MergedPullRequest>;
  /**
   * Dispatch a `workflow_dispatch` event (#471). Adapters that don't
   * support workflow dispatch (Gitea, GitLab) should throw a clear
   * error rather than silently no-op — the caller chose this strategy
   * explicitly and a silent no-op masks a misconfiguration.
   */
  dispatchWorkflow(repo: ConnectedRepoRef, opts: DispatchWorkflowOpts): Promise<void>;

  verifyWebhookSignature(headers: Record<string, string>, body: Buffer, secret: string): Promise<boolean>;
  parseWebhookEvent(headers: Record<string, string>, body: Buffer): VcsEvent;
}
