import { execa } from 'execa';
import crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type {
  ConnectedRepoRef,
  DispatchWorkflowOpts,
  FileChangeStatus,
  MergeOpts,
  MergeResult,
  MergedPullRequest,
  PullRequest,
  PullRequestFile,
  PullRequestOpts,
  VcsEvent,
  VcsProvider,
} from './types.js';
import { parseUnifiedPatch } from './parse-patch.js';

interface GitLabProviderConfig {
  /** Personal access token or project access token with `api` scope. */
  token: string;
  /**
   * GitLab base URL. Defaults to `https://gitlab.com`. Self-hosted
   * instances pass their own (e.g., `https://gitlab.example.com`). The
   * adapter derives the API URL (`<baseUrl>/api/v4`) and the clone URL
   * host from it.
   */
  baseUrl?: string;
}

/**
 * GitLab VCS adapter (#203).
 *
 * GitLab calls them Merge Requests; we surface them through the same
 * `PullRequest` shape as the rest of the project. Three honest
 * differences from GitHub / Gitea worth flagging:
 *
 *  - **Project addressing.** GitLab routes by URL-encoded `owner/repo`
 *    in path segments (e.g., `/projects/acme%2Fweb`). The adapter
 *    handles the encoding here.
 *  - **MR numbering.** Merge requests have two ids — the project-scoped
 *    `iid` (what users see in URLs) and the global `id`. We expose `iid`
 *    as the `PullRequest.number` since that's what users + webhooks
 *    reference.
 *  - **Webhook auth.** GitLab uses a shared-secret `X-Gitlab-Token`
 *    header — NOT HMAC. We do a timing-safe compare against the
 *    configured webhook secret.
 */
export class GitLabProvider implements VcsProvider {
  readonly id = 'gitlab' as const;
  private token: string;
  private apiUrl: string;
  private host: string;

  constructor(cfg: GitLabProviderConfig) {
    this.token = cfg.token;
    const base = cfg.baseUrl ?? 'https://gitlab.com';
    let parsed: URL;
    try {
      parsed = new URL(base);
    } catch {
      throw new Error(`invalid baseUrl: ${base}`);
    }
    this.apiUrl = `${parsed.origin}/api/v4`;
    this.host = parsed.host;
  }

  private async api<T = any>(path: string, init: RequestInit = {}): Promise<T> {
    const r = await fetch(`${this.apiUrl}${path}`, {
      ...init,
      headers: {
        ...(init.headers ?? {}),
        'private-token': this.token,
        accept: 'application/json',
        'content-type': 'application/json',
      },
    });
    if (!r.ok) throw new Error(`gitlab ${r.status}: ${await r.text()}`);
    if (r.status === 204) return undefined as T;
    const text = await r.text();
    if (!text) return undefined as T;
    return JSON.parse(text) as T;
  }

  private cloneUrl(repoFullName: string): string {
    // GitLab supports both `oauth2:<token>@host` and the older
    // `gitlab-ci-token:<token>@host` form. The oauth2 form works for
    // PATs and project access tokens uniformly.
    return `https://oauth2:${this.token}@${this.host}/${repoFullName}.git`;
  }

  private projectPath(repoFullName: string): string {
    return encodeURIComponent(repoFullName);
  }

  // ─── workspace ──────────────────────────────────────────────────────────

  async cloneIntoWorkspace(repo: ConnectedRepoRef, ref: string, dest: string): Promise<void> {
    await fs.mkdir(path.dirname(dest), { recursive: true });
    const url = this.cloneUrl(repo.repoFullName);
    await execa(
      'git',
      ['clone', '--depth', '50', '--filter=blob:none', '--branch', ref, url, dest],
      { stdio: 'inherit', env: gitEnv() },
    );
  }

  async fetchUpdate(workspace: string, ref: string): Promise<void> {
    await execa('git', ['fetch', 'origin', ref], { cwd: workspace, env: gitEnv() });
  }

  async createBranch(workspace: string, name: string, fromRef: string): Promise<void> {
    if (fromRef && fromRef !== 'HEAD') {
      await execa('git', ['checkout', fromRef], { cwd: workspace, env: gitEnv() });
    }
    await execa('git', ['checkout', '-b', name], { cwd: workspace, env: gitEnv() });
  }

  async commit(
    workspace: string,
    opts: { message: string; authorName: string; authorEmail: string; signoff?: boolean },
  ): Promise<string> {
    await execa('git', ['add', '-A'], { cwd: workspace, env: gitEnv() });
    const args = ['commit', '-m', opts.message];
    if (opts.signoff) args.push('--signoff');
    await execa('git', args, {
      cwd: workspace,
      env: {
        ...gitEnv(),
        GIT_AUTHOR_NAME: opts.authorName,
        GIT_AUTHOR_EMAIL: opts.authorEmail,
        GIT_COMMITTER_NAME: opts.authorName,
        GIT_COMMITTER_EMAIL: opts.authorEmail,
      },
    });
    const r = await execa('git', ['rev-parse', 'HEAD'], { cwd: workspace, env: gitEnv() });
    return r.stdout.trim();
  }

  async push(workspace: string, branch: string): Promise<void> {
    await execa('git', ['push', '-u', 'origin', branch], { cwd: workspace, env: gitEnv() });
  }

  // ─── MR operations ──────────────────────────────────────────────────────

  async openPullRequest(repo: ConnectedRepoRef, opts: PullRequestOpts): Promise<PullRequest> {
    const proj = this.projectPath(repo.repoFullName);
    const r = await this.api<any>(`/projects/${proj}/merge_requests`, {
      method: 'POST',
      body: JSON.stringify({
        source_branch: opts.head,
        target_branch: opts.base,
        title: opts.title,
        description: opts.body,
        // GitLab equivalent of "draft" is a `Draft:` title prefix.
        // Honor the option without forcing the convention; the runner
        // doesn't depend on it for tests_failed PRs.
      }),
    });
    return {
      number: r.iid,
      url: r.web_url,
      branch: opts.head,
      state: mrState(r),
    };
  }

  async commentOnPullRequest(repo: ConnectedRepoRef, prNumber: number, body: string): Promise<void> {
    const proj = this.projectPath(repo.repoFullName);
    await this.api(`/projects/${proj}/merge_requests/${prNumber}/notes`, {
      method: 'POST',
      body: JSON.stringify({ body }),
    });
  }

  async postReview(_repo: ConnectedRepoRef, prNumber: number): Promise<void> {
    // GitLab approval API is reviewer-scoped (requires reviewer config
    // on the project) and lacks a 1:1 mapping to GitHub's review event
    // types; #419 ships the GitHub path only.
    // eslint-disable-next-line no-console
    console.warn(
      `[gitlab] postReview(mr=${prNumber}) is not implemented; reviewer agent verdict will not be posted to GitLab.`,
    );
  }

  async markReadyForReview(_repo: ConnectedRepoRef, prNumber: number): Promise<void> {
    // GitLab MRs use the `WIP: ` / `Draft: ` title prefix to indicate
    // draft state; flipping that is title-edit, not implemented yet.
    // eslint-disable-next-line no-console
    console.warn(
      `[gitlab] markReadyForReview(mr=${prNumber}) is a no-op; remove the Draft: prefix manually.`,
    );
  }

  async mergePullRequest(
    repo: ConnectedRepoRef,
    prNumber: number,
    opts: MergeOpts,
  ): Promise<MergeResult> {
    const proj = this.projectPath(repo.repoFullName);
    // GitLab's API doesn't expose distinct merge methods on the merge
    // call — it honors the project's configured strategy. We pass
    // squash for the squash case, otherwise let the project default
    // win. A non-2xx (e.g., MR not mergeable) surfaces via the api()
    // throw and the caller's error handling.
    const r = await this.api<any>(`/projects/${proj}/merge_requests/${prNumber}/merge`, {
      method: 'PUT',
      body: JSON.stringify({
        squash: opts.method === 'squash',
        squash_commit_message: opts.commitMessage,
        merge_commit_message: opts.commitMessage,
      }),
    });
    return {
      sha: r?.merge_commit_sha ?? r?.squash_commit_sha ?? r?.sha ?? '',
      merged: r?.state === 'merged',
    };
  }

  async revertPullRequest(
    repo: ConnectedRepoRef,
    prNumber: number,
  ): Promise<{ revertPrNumber: number }> {
    // GitLab has a server-side revert for merged commits but it
    // requires admin / maintainer scope and goes through the commits
    // endpoint with a target branch. For parity with the GitHub /
    // Gitea adapters and to avoid scope surprises, we do the same
    // clone-revert-push-MR dance here.
    const proj = this.projectPath(repo.repoFullName);
    const mr = await this.api<any>(`/projects/${proj}/merge_requests/${prNumber}`);
    const mergeSha = mr.merge_commit_sha ?? mr.squash_commit_sha;
    if (!mergeSha) throw new Error(`MR !${prNumber} not merged`);
    const branch = `mergecrew/revert-${prNumber}-${shortSha(mergeSha)}`;

    const tmp = await fs.mkdtemp(path.join(process.env.TMPDIR ?? '/tmp', 'mergecrew-revert-'));
    try {
      const url = this.cloneUrl(repo.repoFullName);
      await execa('git', ['clone', '--depth', '50', url, tmp], { env: gitEnv() });
      await execa('git', ['fetch', 'origin', repo.defaultBranch], { cwd: tmp, env: gitEnv() });
      await execa('git', ['checkout', repo.defaultBranch], { cwd: tmp, env: gitEnv() });
      await execa('git', ['checkout', '-b', branch], { cwd: tmp, env: gitEnv() });
      await execa('git', ['revert', '--no-edit', '-m', '1', mergeSha], { cwd: tmp, env: gitEnv() });
      await execa('git', ['push', '-u', 'origin', branch], { cwd: tmp, env: gitEnv() });

      const r = await this.api<any>(`/projects/${proj}/merge_requests`, {
        method: 'POST',
        body: JSON.stringify({
          source_branch: branch,
          target_branch: repo.defaultBranch,
          title: `Revert "${mr.title}"`,
          description: `Reverts !${prNumber} via Mergecrew.`,
        }),
      });
      return { revertPrNumber: r.iid };
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  }

  async closePullRequest(repo: ConnectedRepoRef, prNumber: number): Promise<void> {
    const proj = this.projectPath(repo.repoFullName);
    await this.api(`/projects/${proj}/merge_requests/${prNumber}`, {
      method: 'PUT',
      body: JSON.stringify({ state_event: 'close' }),
    });
  }

  async listOpenPullRequests(repo: ConnectedRepoRef): Promise<PullRequest[]> {
    const proj = this.projectPath(repo.repoFullName);
    const list = await this.api<any[]>(
      `/projects/${proj}/merge_requests?state=opened&per_page=50`,
    );
    return list.map((p) => ({
      number: p.iid,
      url: p.web_url,
      branch: p.source_branch,
      state: 'open',
    }));
  }

  async getDefaultBranch(repo: ConnectedRepoRef): Promise<string> {
    const proj = this.projectPath(repo.repoFullName);
    const r = await this.api<any>(`/projects/${proj}`);
    return r.default_branch ?? 'main';
  }

  async getFileAt(
    repo: ConnectedRepoRef,
    ref: string,
    filepath: string,
  ): Promise<{ contentBase64: string }> {
    const proj = this.projectPath(repo.repoFullName);
    // GitLab's files endpoint already returns base64-encoded content
    // when `?ref=...` is set, so no transcoding here.
    const enc = encodeURIComponent(filepath);
    const data = await this.api<any>(
      `/projects/${proj}/repository/files/${enc}?ref=${encodeURIComponent(ref)}`,
    );
    if (!data || typeof data.content !== 'string' || data.encoding !== 'base64') {
      throw new Error(`not a file or unsupported encoding: ${filepath}`);
    }
    return { contentBase64: data.content };
  }

  async getPullRequestFiles(
    repo: ConnectedRepoRef,
    prNumber: number,
  ): Promise<PullRequestFile[]> {
    const proj = this.projectPath(repo.repoFullName);
    const r = await this.api<any>(`/projects/${proj}/merge_requests/${prNumber}/changes`);
    const changes: any[] = r?.changes ?? [];
    return changes.map((c) => {
      const status = mapStatus(c);
      const path = c.new_path ?? c.old_path ?? '';
      const oldPath = c.renamed_file ? c.old_path ?? null : null;
      const counts = countLinesFromDiff(c.diff ?? '');
      return {
        path,
        oldPath,
        status,
        additions: counts.added,
        deletions: counts.deleted,
        hunks: parseUnifiedPatch(c.diff ?? ''),
      };
    });
  }

  // ─── promote engine helpers (#471) ──────────────────────────────────────

  async getMergedPullRequest(
    _repo: ConnectedRepoRef,
    _prNumber: number,
  ): Promise<MergedPullRequest> {
    // GitLab-side promote engine wiring lands when cherry-pick is
    // generalized beyond GitHub. Throwing rather than no-op-ing keeps
    // misconfigured projects from silently producing empty release refs.
    throw new Error('getMergedPullRequest is not implemented for the GitLab adapter');
  }

  async dispatchWorkflow(
    _repo: ConnectedRepoRef,
    _opts: DispatchWorkflowOpts,
  ): Promise<void> {
    throw new Error('dispatchWorkflow is not supported by the GitLab adapter');
  }

  // ─── webhooks ───────────────────────────────────────────────────────────

  async verifyWebhookSignature(
    headers: Record<string, string>,
    _body: Buffer,
    secret: string,
  ): Promise<boolean> {
    // GitLab does NOT send an HMAC. It sends a shared secret token
    // verbatim in `X-Gitlab-Token`. Constant-time compare avoids
    // timing leakage during normal traffic.
    const provided = headers['x-gitlab-token'] ?? headers['X-Gitlab-Token'];
    if (!provided || !secret) return false;
    const a = Buffer.from(provided);
    const b = Buffer.from(secret);
    if (a.length !== b.length) return false;
    try {
      return crypto.timingSafeEqual(a, b);
    } catch {
      return false;
    }
  }

  parseWebhookEvent(headers: Record<string, string>, body: Buffer): VcsEvent {
    const event = headers['x-gitlab-event'] ?? headers['X-Gitlab-Event'];
    const json = JSON.parse(body.toString('utf8'));
    switch (event) {
      case 'Merge Request Hook':
        return {
          kind: 'pull_request',
          action: json.object_attributes?.action ?? 'unknown',
          prNumber: json.object_attributes?.iid,
          repoFullName: json.project?.path_with_namespace,
          raw: json,
        };
      case 'Pipeline Hook':
        // GitLab pipelines are the closest thing to GitHub workflow_runs.
        return {
          kind: 'workflow_run',
          action: json.object_attributes?.status ?? 'unknown',
          runId: Number(json.object_attributes?.id ?? 0),
          repoFullName: json.project?.path_with_namespace,
          raw: json,
        };
      default:
        return { kind: 'unknown', raw: json };
    }
  }
}

function gitEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
  };
}

function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

function mrState(p: any): 'open' | 'closed' | 'merged' {
  if (p.state === 'merged') return 'merged';
  if (p.state === 'closed' || p.state === 'locked') return 'closed';
  return 'open';
}

function mapStatus(c: any): FileChangeStatus {
  if (c.new_file) return 'added';
  if (c.deleted_file) return 'removed';
  if (c.renamed_file) return 'renamed';
  return 'modified';
}

/**
 * GitLab returns a single `diff` string per change, not pre-counted
 * additions/deletions. Count `+` and `-` lines (ignoring `+++` /
 * `---` headers and `@@` hunks) for parity with the GitHub adapter.
 */
function countLinesFromDiff(diff: string): { added: number; deleted: number } {
  let added = 0;
  let deleted = 0;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('@@')) continue;
    if (line.startsWith('+')) added++;
    else if (line.startsWith('-')) deleted++;
  }
  return { added, deleted };
}
