import { createAppAuth } from '@octokit/auth-app';
import { Octokit } from '@octokit/rest';
import crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  assertPushableBranch,
  basicAuth,
  gitClone,
  gitCommitAll,
  gitCreateBranch,
  gitFetch,
  gitPush,
  gitRevertToBranch,
  type GitHttpAuth,
} from './safe-git.js';
import type {
  CommitOpts,
  ConnectedRepoRef,
  DispatchWorkflowOpts,
  InstallationTokenScope,
  PushOpts,
  FileChangeStatus,
  MergeOpts,
  MergeResult,
  MergedPullRequest,
  PostReviewOpts,
  PullRequest,
  PullRequestFile,
  PullRequestOpts,
  VcsEvent,
  VcsProvider,
} from './types.js';
import { parseUnifiedPatch } from './parse-patch.js';

interface GitHubProviderConfig {
  appId: string;
  privateKey: string;
  clientId?: string;
  clientSecret?: string;
  /**
   * GitHub Enterprise Server support (#205). When unset, the adapter
   * targets github.com via the default api.github.com REST surface.
   * Set to e.g. `https://github.example.com` for GHES — the adapter
   * derives the API URL (`<baseUrl>/api/v3`) and clone URL host from
   * it. The webhook + auth-app machinery is identical between
   * github.com and GHES, so no other plumbing changes.
   */
  baseUrl?: string;
  /**
   * Called before every installation-token mint (clone, push, PR, API
   * calls, `getInstallationToken`). Must throw when the installation is
   * not allowed for the caller — the runner uses it to refuse
   * installations that aren't bound to the repo's org.
   */
  authorizeInstallation?: (installationId: string) => Promise<void>;
}

export class GitHubProvider implements VcsProvider {
  readonly id = 'github' as const;
  private auth: ReturnType<typeof createAppAuth>;
  private appId: string;
  private privateKey: string;
  private apiUrl: string;
  private host: string;
  private authorizeInstallation?: (installationId: string) => Promise<void>;

  constructor(cfg: GitHubProviderConfig) {
    this.appId = cfg.appId;
    this.authorizeInstallation = cfg.authorizeInstallation;
    this.privateKey = cfg.privateKey;
    const { apiUrl, host } = resolveBaseUrls(cfg.baseUrl);
    this.apiUrl = apiUrl;
    this.host = host;
    this.auth = createAppAuth({
      appId: cfg.appId,
      privateKey: cfg.privateKey,
      clientId: cfg.clientId,
      clientSecret: cfg.clientSecret,
      // auth-app honors `request.baseUrl` for the token-fetch endpoint;
      // setting it here keeps GHES auth flowing through the right host.
      ...(cfg.baseUrl
        ? { request: { baseUrl: apiUrl } as any }
        : {}),
    });
  }

  // ─── tokens ─────────────────────────────────────────────────────────────

  /**
   * Mint an installation token. Every mint (clone, fetch, push, PR / API
   * calls, `getInstallationToken`, revert) goes through here, so the
   * `authorizeInstallation` binding check always runs first. When
   * `scope` names a repository and/or permissions, the token is
   * down-scoped to exactly that (GitHub enforces it server-side) — a
   * leaked token cannot touch other repos in the customer's
   * installation or exceed the operation's needs.
   */
  private async tokenFor(installationId: string, scope?: InstallationTokenScope): Promise<string> {
    if (this.authorizeInstallation) await this.authorizeInstallation(installationId);
    const req: Record<string, unknown> = { type: 'installation', installationId: Number(installationId) };
    if (scope?.repoId && /^\d+$/.test(scope.repoId)) {
      req.repositoryIds = [Number(scope.repoId)];
    } else if (scope?.repoFullName) {
      req.repositoryNames = [parseRepo(scope.repoFullName).name];
    }
    if (scope?.permissions) req.permissions = scope.permissions;
    const r: any = await this.auth(req as any);
    return r.token;
  }

  /**
   * Public access to an installation token (#550) for the runner's other
   * GitHub-backed adapters. Callers should pass a `scope`; without one
   * the token is installation-wide.
   */
  async getInstallationToken(installationId: string, scope?: InstallationTokenScope): Promise<string> {
    return this.tokenFor(installationId, scope);
  }

  private async kit(repo: ConnectedRepoRef, permissions: Record<string, 'read' | 'write'>): Promise<Octokit> {
    const token = await this.tokenFor(repo.installationId, scopeFor(repo, permissions));
    return new Octokit({ auth: token, baseUrl: this.apiUrl });
  }

  private cleanUrl(repoFullName: string): string {
    parseRepo(repoFullName);
    return `https://${this.host}/${repoFullName}.git`;
  }

  private async gitAuth(repo: ConnectedRepoRef, permissions: Record<string, 'read' | 'write'>): Promise<GitHttpAuth> {
    const token = await this.tokenFor(repo.installationId, scopeFor(repo, permissions));
    return basicAuth(`https://${this.host}`, 'x-access-token', token);
  }

  // ─── workspace ──────────────────────────────────────────────────────────
  //
  // All workspace git goes through `safe-git` (minimal env, hooks /
  // fsmonitor / filters disabled, repo config validated). The token is
  // passed per invocation and never lands in `.git/config`.

  async cloneIntoWorkspace(repo: ConnectedRepoRef, ref: string, dest: string): Promise<void> {
    await gitClone({
      cleanUrl: this.cleanUrl(repo.repoFullName),
      ref,
      dest,
      auth: await this.gitAuth(repo, PERMS.read),
    });
  }

  async fetchUpdate(workspace: string, ref: string, repo: ConnectedRepoRef): Promise<void> {
    await gitFetch(workspace, this.cleanUrl(repo.repoFullName), ref, await this.gitAuth(repo, PERMS.read));
  }

  async createBranch(workspace: string, name: string, fromRef: string): Promise<void> {
    await gitCreateBranch(workspace, name, fromRef);
  }

  async commit(workspace: string, opts: CommitOpts): Promise<string> {
    return gitCommitAll(workspace, opts);
  }

  async push(workspace: string, branch: string, repo: ConnectedRepoRef, opts: PushOpts = {}): Promise<void> {
    // Validate before minting a write token.
    if (!opts.allowAnyBranchPrefix) assertPushableBranch(branch, [...(opts.protectedBranches ?? []), repo.defaultBranch]);
    await gitPush(workspace, this.cleanUrl(repo.repoFullName), branch, await this.gitAuth(repo, PERMS.push), {
      ...opts,
      protectedBranches: [...(opts.protectedBranches ?? []), repo.defaultBranch],
    });
  }

  // ─── PR operations ──────────────────────────────────────────────────────

  async openPullRequest(repo: ConnectedRepoRef, opts: PullRequestOpts): Promise<PullRequest> {
    const kit = await this.kit(repo, PERMS.prWrite);
    const { owner, name } = parseRepo(repo.repoFullName);
    const r = await kit.pulls.create({
      owner,
      repo: name,
      head: opts.head,
      base: opts.base,
      title: opts.title,
      body: opts.body,
      draft: !!opts.draft,
    });
    return {
      number: r.data.number,
      url: r.data.html_url,
      branch: opts.head,
      state: r.data.state === 'closed' ? (r.data.merged_at ? 'merged' : 'closed') : 'open',
    };
  }

  async commentOnPullRequest(repo: ConnectedRepoRef, prNumber: number, body: string): Promise<void> {
    const kit = await this.kit(repo, PERMS.prWrite);
    const { owner, name } = parseRepo(repo.repoFullName);
    await kit.issues.createComment({ owner, repo: name, issue_number: prNumber, body });
  }

  async postReview(
    repo: ConnectedRepoRef,
    prNumber: number,
    opts: PostReviewOpts,
  ): Promise<void> {
    const kit = await this.kit(repo, PERMS.prWrite);
    const { owner, name } = parseRepo(repo.repoFullName);
    // GitHub's review API takes uppercase events; map our union to it.
    const event =
      opts.event === 'approve'
        ? 'APPROVE'
        : opts.event === 'request_changes'
          ? 'REQUEST_CHANGES'
          : 'COMMENT';
    await kit.pulls.createReview({
      owner,
      repo: name,
      pull_number: prNumber,
      event,
      body: opts.body,
      // Inline comments shape: { path, line, side: 'RIGHT', body }. We
      // emit only post-image (RIGHT) comments — the reviewer agent
      // points at the proposed code, not the pre-image. `comments` is
      // intentionally omitted when empty so we don't trip GitHub's
      // "comments must be a non-empty array if provided" validation.
      ...(opts.comments && opts.comments.length > 0
        ? {
            comments: opts.comments.map((c) => ({
              path: c.path,
              line: c.line,
              side: 'RIGHT' as const,
              body: c.body,
            })),
          }
        : {}),
    });
  }

  async markReadyForReview(repo: ConnectedRepoRef, prNumber: number): Promise<void> {
    const kit = await this.kit(repo, PERMS.prWrite);
    const { owner, name } = parseRepo(repo.repoFullName);
    // Need the PR's node_id for the GraphQL mutation. REST PR object
    // exposes it on `data.node_id`.
    const pr = await kit.pulls.get({ owner, repo: name, pull_number: prNumber });
    const nodeId = pr.data.node_id;
    if (!nodeId) {
      // Shouldn't happen on any current GH response, but bail loudly
      // rather than send an undefined into GraphQL.
      throw new Error(`GitHub PR #${prNumber} missing node_id`);
    }
    await kit.graphql<{ markPullRequestReadyForReview: { pullRequest: { isDraft: boolean } } }>(
      `mutation MarkReady($id: ID!) {
        markPullRequestReadyForReview(input: { pullRequestId: $id }) {
          pullRequest { isDraft }
        }
      }`,
      { id: nodeId },
    );
  }

  async mergePullRequest(
    repo: ConnectedRepoRef,
    prNumber: number,
    opts: MergeOpts,
  ): Promise<MergeResult> {
    const kit = await this.kit(repo, PERMS.merge);
    const { owner, name } = parseRepo(repo.repoFullName);
    const r = await kit.pulls.merge({
      owner,
      repo: name,
      pull_number: prNumber,
      merge_method: opts.method,
      commit_title: opts.commitTitle,
      commit_message: opts.commitMessage,
    });
    return { sha: r.data.sha, merged: r.data.merged };
  }

  async revertPullRequest(
    repo: ConnectedRepoRef,
    prNumber: number,
  ): Promise<{ revertPrNumber: number }> {
    // Open a new PR that reverts the merged commit. We do this client-side:
    //   1) fetch the PR
    //   2) clone temp workspace, run `git revert <sha>` on the default branch, push
    //   3) open a PR
    const kit = await this.kit(repo, PERMS.revert);
    const { owner, name } = parseRepo(repo.repoFullName);
    const pr = await kit.pulls.get({ owner, repo: name, pull_number: prNumber });
    const mergeSha = pr.data.merge_commit_sha;
    if (!mergeSha) throw new Error(`PR #${prNumber} not merged`);
    const branch = `mergecrew/revert-${prNumber}-${shortSha(mergeSha)}`;

    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mergecrew-revert-'));
    try {
      await gitRevertToBranch({
        dir: path.join(tmp, 'repo'),
        cleanUrl: this.cleanUrl(repo.repoFullName),
        auth: await this.gitAuth(repo, PERMS.push),
        baseBranch: repo.defaultBranch,
        branch,
        mergeSha,
      });

      const r = await kit.pulls.create({
        owner,
        repo: name,
        head: branch,
        base: repo.defaultBranch,
        title: `Revert "${pr.data.title}"`,
        body: `Reverts #${prNumber} via Mergecrew.`,
      });
      return { revertPrNumber: r.data.number };
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  }

  async closePullRequest(repo: ConnectedRepoRef, prNumber: number): Promise<void> {
    const kit = await this.kit(repo, PERMS.prWrite);
    const { owner, name } = parseRepo(repo.repoFullName);
    await kit.pulls.update({ owner, repo: name, pull_number: prNumber, state: 'closed' });
  }

  async listOpenPullRequests(repo: ConnectedRepoRef): Promise<PullRequest[]> {
    const kit = await this.kit(repo, PERMS.read);
    const { owner, name } = parseRepo(repo.repoFullName);
    const r = await kit.pulls.list({ owner, repo: name, state: 'open', per_page: 50 });
    return r.data.map((p) => ({
      number: p.number,
      url: p.html_url,
      branch: p.head.ref,
      state: 'open',
    }));
  }

  async getDefaultBranch(repo: ConnectedRepoRef): Promise<string> {
    const kit = await this.kit(repo, PERMS.read);
    const { owner, name } = parseRepo(repo.repoFullName);
    const r = await kit.repos.get({ owner, repo: name });
    return r.data.default_branch;
  }

  async getFileAt(
    repo: ConnectedRepoRef,
    ref: string,
    filepath: string,
  ): Promise<{ contentBase64: string }> {
    const kit = await this.kit(repo, PERMS.read);
    const { owner, name } = parseRepo(repo.repoFullName);
    const r = await kit.repos.getContent({ owner, repo: name, path: filepath, ref });
    const data = r.data as any;
    if (Array.isArray(data) || data.type !== 'file' || typeof data.content !== 'string') {
      throw new Error(`not a file or unsupported: ${filepath}`);
    }
    return { contentBase64: data.content };
  }

  async getPullRequestFiles(
    repo: ConnectedRepoRef,
    prNumber: number,
  ): Promise<PullRequestFile[]> {
    const kit = await this.kit(repo, PERMS.read);
    const { owner, name } = parseRepo(repo.repoFullName);
    // Paginate — large PRs return >100 files.
    const files = await kit.paginate(kit.pulls.listFiles, {
      owner,
      repo: name,
      pull_number: prNumber,
      per_page: 100,
    });
    return files.map((f) => ({
      path: f.filename,
      oldPath: f.previous_filename ?? null,
      status: mapStatus(f.status),
      additions: f.additions,
      deletions: f.deletions,
      hunks: parseUnifiedPatch(f.patch),
    }));
  }

  // ─── installation repos ────────────────────────────────────────────────

  /**
   * List the repos the App's installation has been granted access to.
   * Used by the BFF after a fresh install to populate a repo dropdown
   * (#184) so the user doesn't have to retype names the App already knows.
   * Pages through GitHub's 100-per-page cap.
   */
  async listInstallationRepos(
    installationId: string,
  ): Promise<Array<{ repoId: string; repoFullName: string; defaultBranch: string; private: boolean }>> {
    // Installation-wide by necessity (it enumerates repos), but
    // metadata-only.
    const token = await this.tokenFor(installationId, { permissions: { metadata: 'read' } });
    const kit = new Octokit({ auth: token, baseUrl: this.apiUrl });
    const repos = await kit.paginate(kit.apps.listReposAccessibleToInstallation, {
      per_page: 100,
    });
    return repos.map((r: any) => ({
      repoId: String(r.id),
      repoFullName: r.full_name,
      defaultBranch: r.default_branch ?? 'main',
      private: !!r.private,
    }));
  }

  // ─── promote engine helpers (#471) ──────────────────────────────────────

  async getMergedPullRequest(
    repo: ConnectedRepoRef,
    prNumber: number,
  ): Promise<MergedPullRequest> {
    const kit = await this.kit(repo, PERMS.read);
    const { owner, name } = parseRepo(repo.repoFullName);
    const pr = await kit.pulls.get({ owner, repo: name, pull_number: prNumber });
    const mergeSha = pr.data.merge_commit_sha;
    let isMergeCommit = false;
    if (mergeSha) {
      // Squash- and rebase-merges produce single-parent commits; true
      // merges have 2+ parents. Cherry-pick of the former is plain;
      // the latter needs `-m 1` to pick the first-parent diff.
      const commit = await kit.repos.getCommit({ owner, repo: name, ref: mergeSha });
      isMergeCommit = (commit.data.parents?.length ?? 1) >= 2;
    }
    return {
      number: pr.data.number,
      title: pr.data.title,
      body: pr.data.body ?? null,
      url: pr.data.html_url,
      mergeCommitSha: mergeSha,
      mergedAt: pr.data.merged_at,
      isMergeCommit,
      headBranch: pr.data.head.ref,
    };
  }

  async dispatchWorkflow(
    repo: ConnectedRepoRef,
    opts: DispatchWorkflowOpts,
  ): Promise<void> {
    const kit = await this.kit(repo, PERMS.dispatch);
    const { owner, name } = parseRepo(repo.repoFullName);
    await kit.actions.createWorkflowDispatch({
      owner,
      repo: name,
      workflow_id: opts.workflowFilename,
      ref: opts.ref,
      inputs: opts.inputs ?? {},
    });
  }

  // ─── webhooks ───────────────────────────────────────────────────────────

  async verifyWebhookSignature(
    headers: Record<string, string>,
    body: Buffer,
    secret: string,
  ): Promise<boolean> {
    // Fail closed: an empty key would let anyone compute a valid HMAC.
    if (!secret) return false;
    const sig = headers['x-hub-signature-256'] ?? headers['X-Hub-Signature-256'];
    if (!sig || !sig.startsWith('sha256=')) return false;
    const expected = crypto
      .createHmac('sha256', secret)
      .update(body)
      .digest('hex');
    const provided = sig.slice('sha256='.length);
    if (provided.length !== expected.length) return false;
    try {
      return crypto.timingSafeEqual(Buffer.from(provided, 'hex'), Buffer.from(expected, 'hex'));
    } catch {
      return false;
    }
  }

  parseWebhookEvent(headers: Record<string, string>, body: Buffer): VcsEvent {
    const event = headers['x-github-event'] ?? headers['X-GitHub-Event'];
    const json = JSON.parse(body.toString('utf8'));
    switch (event) {
      case 'pull_request':
        return {
          kind: 'pull_request',
          action: json.action,
          prNumber: json.pull_request?.number,
          repoFullName: json.repository?.full_name,
          raw: json,
        };
      case 'workflow_run':
        return {
          kind: 'workflow_run',
          action: json.action,
          runId: json.workflow_run?.id,
          repoFullName: json.repository?.full_name,
          raw: json,
        };
      case 'check_run':
        return {
          kind: 'check_run',
          action: json.action,
          repoFullName: json.repository?.full_name,
          raw: json,
        };
      case 'installation':
      case 'installation_repositories':
        return {
          kind: 'installation',
          action: json.action,
          installationId: String(json.installation?.id),
          raw: json,
        };
      default:
        return { kind: 'unknown', raw: json };
    }
  }
}

/**
 * Map an optional `baseUrl` to the Octokit API URL + host used in clone
 * URLs (#205). For github.com the API lives at api.github.com and the
 * clone host is github.com. For GHES the operator gives us
 * `https://github.example.com`; the API lives at
 * `https://github.example.com/api/v3` and the clone host is
 * `github.example.com`.
 */
function resolveBaseUrls(baseUrl: string | undefined): { apiUrl: string; host: string } {
  if (!baseUrl) {
    return { apiUrl: 'https://api.github.com', host: 'github.com' };
  }
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new Error(`invalid baseUrl: ${baseUrl}`);
  }
  const host = parsed.host;
  // Strip trailing slash for clean concatenation.
  const apiUrl = `${parsed.origin}/api/v3`;
  return { apiUrl, host };
}

/**
 * Minimal permission sets per operation. Requested on every mint so a
 * token never carries more than the call needs (GitHub refuses to mint
 * permissions the App does not hold, and silently drops none).
 */
const PERMS = {
  read: { contents: 'read', pull_requests: 'read', metadata: 'read' },
  push: { contents: 'write', metadata: 'read' },
  prWrite: { pull_requests: 'write', contents: 'read', metadata: 'read' },
  merge: { contents: 'write', pull_requests: 'write', metadata: 'read' },
  revert: { pull_requests: 'write', contents: 'read', metadata: 'read' },
  dispatch: { actions: 'write', contents: 'read', metadata: 'read' },
} as const satisfies Record<string, Record<string, 'read' | 'write'>>;

function scopeFor(
  repo: ConnectedRepoRef,
  permissions: Record<string, 'read' | 'write'>,
): InstallationTokenScope {
  return { repoId: repo.repoId, repoFullName: repo.repoFullName, permissions };
}

const REPO_PART = /^[A-Za-z0-9_.-]+$/;

function parseRepo(full: string): { owner: string; name: string } {
  const parts = full.split('/');
  const [owner, name] = parts;
  if (parts.length !== 2 || !owner || !name || !REPO_PART.test(owner) || !REPO_PART.test(name) || name === '.' || name === '..') {
    throw new Error(`invalid repoFullName: ${full}`);
  }
  return { owner, name };
}

function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

function mapStatus(s: string): FileChangeStatus {
  // GitHub's `files[].status` covers added / removed / modified / renamed /
  // copied / changed / unchanged. We collapse copied into added and changed
  // and unchanged into modified — they don't carry distinct review intent.
  if (s === 'added' || s === 'copied') return 'added';
  if (s === 'removed') return 'removed';
  if (s === 'renamed') return 'renamed';
  return 'modified';
}
