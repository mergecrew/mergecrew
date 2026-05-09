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
  mergePullRequest(repo: ConnectedRepoRef, prNumber: number, opts: MergeOpts): Promise<MergeResult>;
  revertPullRequest(repo: ConnectedRepoRef, prNumber: number): Promise<{ revertPrNumber: number }>;
  closePullRequest(repo: ConnectedRepoRef, prNumber: number): Promise<void>;

  listOpenPullRequests(repo: ConnectedRepoRef): Promise<PullRequest[]>;
  getDefaultBranch(repo: ConnectedRepoRef): Promise<string>;
  getFileAt(repo: ConnectedRepoRef, ref: string, path: string): Promise<{ contentBase64: string }>;
  getPullRequestFiles(repo: ConnectedRepoRef, prNumber: number): Promise<PullRequestFile[]>;

  verifyWebhookSignature(headers: Record<string, string>, body: Buffer, secret: string): Promise<boolean>;
  parseWebhookEvent(headers: Record<string, string>, body: Buffer): VcsEvent;
}
