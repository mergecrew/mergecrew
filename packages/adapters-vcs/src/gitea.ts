import { execa } from 'execa';
import crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type {
  ConnectedRepoRef,
  FileChangeStatus,
  MergeOpts,
  MergeResult,
  PullRequest,
  PullRequestFile,
  PullRequestOpts,
  VcsEvent,
  VcsProvider,
} from './types.js';
import { parseUnifiedPatch } from './parse-patch.js';

interface GiteaProviderConfig {
  /** A personal access token from a Gitea user with repo + write_pull_request scope. */
  token: string;
  /**
   * Base URL of the Gitea instance — e.g., \`https://gitea.example.com\` or
   * \`https://codeberg.org\`. The adapter derives the API URL
   * (\`<baseUrl>/api/v1\`) and the clone URL host from it.
   */
  baseUrl: string;
}

/**
 * Gitea VCS adapter (#204).
 *
 * Gitea's REST API is intentionally GitHub-compatible — same paths,
 * same response shapes, just \`/api/v1\` instead of \`/api/v3\`. The bulk
 * of this adapter is therefore close in spirit to the GitHub adapter,
 * with three honest differences:
 *
 *  - **Auth:** PAT-based (\`Authorization: token <pat>\`) rather than
 *    GitHub Apps + installation tokens. Gitea does have OAuth2 but PAT
 *    is the typical CI / automation path.
 *  - **Webhook signature header:** \`X-Gitea-Signature\` rather than
 *    \`X-Hub-Signature-256\`. Same HMAC-SHA256 crypto.
 *  - **Webhook event header:** \`X-Gitea-Event\`. Event names mostly
 *    overlap with GitHub (\`pull_request\`, \`push\`, \`issues\`); we map
 *    the ones the orchestrator actually consumes.
 *
 * Git-shell methods (clone, branch, commit, push) reuse the same
 * \`git\` CLI under \`execa\` as the GitHub adapter.
 */
export class GiteaProvider implements VcsProvider {
  readonly id = 'gitea' as const;
  private token: string;
  private apiUrl: string;
  private host: string;

  constructor(cfg: GiteaProviderConfig) {
    this.token = cfg.token;
    let parsed: URL;
    try {
      parsed = new URL(cfg.baseUrl);
    } catch {
      throw new Error(`invalid baseUrl: ${cfg.baseUrl}`);
    }
    this.apiUrl = `${parsed.origin}/api/v1`;
    this.host = parsed.host;
  }

  private async api<T = any>(path: string, init: RequestInit = {}): Promise<T> {
    const r = await fetch(`${this.apiUrl}${path}`, {
      ...init,
      headers: {
        ...(init.headers ?? {}),
        authorization: `token ${this.token}`,
        accept: 'application/json',
        'content-type': 'application/json',
      },
    });
    if (!r.ok) throw new Error(`gitea ${r.status}: ${await r.text()}`);
    if (r.status === 204) return undefined as T;
    // Some Gitea endpoints (e.g., \`/pulls/{n}/merge\`) return 200 with an
    // empty body — \`r.json()\` would throw. Read text first and only
    // parse if there's something to parse.
    const text = await r.text();
    if (!text) return undefined as T;
    return JSON.parse(text) as T;
  }

  private cloneUrl(repoFullName: string): string {
    return `https://${this.token}:x-oauth-basic@${this.host}/${repoFullName}.git`;
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

  // ─── PR operations ──────────────────────────────────────────────────────

  async openPullRequest(repo: ConnectedRepoRef, opts: PullRequestOpts): Promise<PullRequest> {
    const { owner, name } = parseRepo(repo.repoFullName);
    const r = await this.api<any>(`/repos/${owner}/${name}/pulls`, {
      method: 'POST',
      body: JSON.stringify({
        head: opts.head,
        base: opts.base,
        title: opts.title,
        body: opts.body,
        // Gitea PRs don't have a draft flag; tests_failed PRs land as
        // open and the title carries the [WIP] / draft hint via title
        // convention if needed. Keeping behavior parity by ignoring
        // \`draft\` here.
      }),
    });
    return {
      number: r.number,
      url: r.html_url,
      branch: opts.head,
      state: prState(r),
    };
  }

  async commentOnPullRequest(repo: ConnectedRepoRef, prNumber: number, body: string): Promise<void> {
    const { owner, name } = parseRepo(repo.repoFullName);
    await this.api(`/repos/${owner}/${name}/issues/${prNumber}/comments`, {
      method: 'POST',
      body: JSON.stringify({ body }),
    });
  }

  async mergePullRequest(
    repo: ConnectedRepoRef,
    prNumber: number,
    opts: MergeOpts,
  ): Promise<MergeResult> {
    const { owner, name } = parseRepo(repo.repoFullName);
    // Gitea's merge endpoint returns 200 on success but no body shape
    // matching GitHub's. We refetch the PR for the merge sha.
    await this.api(`/repos/${owner}/${name}/pulls/${prNumber}/merge`, {
      method: 'POST',
      body: JSON.stringify({
        Do: opts.method, // gitea field name
        MergeTitleField: opts.commitTitle,
        MergeMessageField: opts.commitMessage,
      }),
    });
    const pr = await this.api<any>(`/repos/${owner}/${name}/pulls/${prNumber}`);
    return { sha: pr.merge_commit_sha ?? pr.head?.sha ?? '', merged: !!pr.merged };
  }

  async revertPullRequest(
    repo: ConnectedRepoRef,
    prNumber: number,
  ): Promise<{ revertPrNumber: number }> {
    // Gitea has no native revert endpoint. Same shape as GitHub: clone,
    // \`git revert\`, push, open a fresh PR.
    const { owner, name } = parseRepo(repo.repoFullName);
    const pr = await this.api<any>(`/repos/${owner}/${name}/pulls/${prNumber}`);
    const mergeSha = pr.merge_commit_sha;
    if (!mergeSha) throw new Error(`PR #${prNumber} not merged`);
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

      const r = await this.api<any>(`/repos/${owner}/${name}/pulls`, {
        method: 'POST',
        body: JSON.stringify({
          head: branch,
          base: repo.defaultBranch,
          title: `Revert "${pr.title}"`,
          body: `Reverts #${prNumber} via Mergecrew.`,
        }),
      });
      return { revertPrNumber: r.number };
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  }

  async closePullRequest(repo: ConnectedRepoRef, prNumber: number): Promise<void> {
    const { owner, name } = parseRepo(repo.repoFullName);
    await this.api(`/repos/${owner}/${name}/pulls/${prNumber}`, {
      method: 'PATCH',
      body: JSON.stringify({ state: 'closed' }),
    });
  }

  async listOpenPullRequests(repo: ConnectedRepoRef): Promise<PullRequest[]> {
    const { owner, name } = parseRepo(repo.repoFullName);
    const list = await this.api<any[]>(`/repos/${owner}/${name}/pulls?state=open&limit=50`);
    return list.map((p) => ({
      number: p.number,
      url: p.html_url,
      branch: p.head?.ref ?? '',
      state: 'open',
    }));
  }

  async getDefaultBranch(repo: ConnectedRepoRef): Promise<string> {
    const { owner, name } = parseRepo(repo.repoFullName);
    const r = await this.api<any>(`/repos/${owner}/${name}`);
    return r.default_branch ?? 'main';
  }

  async getFileAt(
    repo: ConnectedRepoRef,
    ref: string,
    filepath: string,
  ): Promise<{ contentBase64: string }> {
    const { owner, name } = parseRepo(repo.repoFullName);
    const qs = new URLSearchParams({ ref });
    const data = await this.api<any>(
      `/repos/${owner}/${name}/contents/${encodeURIComponent(filepath)}?${qs}`,
    );
    if (Array.isArray(data) || data.type !== 'file' || typeof data.content !== 'string') {
      throw new Error(`not a file or unsupported: ${filepath}`);
    }
    return { contentBase64: data.content };
  }

  async getPullRequestFiles(
    repo: ConnectedRepoRef,
    prNumber: number,
  ): Promise<PullRequestFile[]> {
    const { owner, name } = parseRepo(repo.repoFullName);
    // Gitea exposes \`/pulls/{index}/files\` with the same shape as GitHub.
    // We hand-paginate since there's no first-class paginate helper here.
    const out: PullRequestFile[] = [];
    let page = 1;
    while (true) {
      const batch = await this.api<any[]>(
        `/repos/${owner}/${name}/pulls/${prNumber}/files?limit=50&page=${page}`,
      );
      if (!batch || batch.length === 0) break;
      for (const f of batch) {
        out.push({
          path: f.filename,
          oldPath: f.previous_filename ?? null,
          status: mapStatus(f.status),
          additions: f.additions ?? 0,
          deletions: f.deletions ?? 0,
          hunks: parseUnifiedPatch(f.patch),
        });
      }
      if (batch.length < 50) break;
      page++;
    }
    return out;
  }

  // ─── webhooks ───────────────────────────────────────────────────────────

  async verifyWebhookSignature(
    headers: Record<string, string>,
    body: Buffer,
    secret: string,
  ): Promise<boolean> {
    const sig = headers['x-gitea-signature'] ?? headers['X-Gitea-Signature'];
    if (!sig) return false;
    const expected = crypto.createHmac('sha256', secret).update(body).digest('hex');
    if (sig.length !== expected.length) return false;
    try {
      return crypto.timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(expected, 'hex'));
    } catch {
      return false;
    }
  }

  parseWebhookEvent(headers: Record<string, string>, body: Buffer): VcsEvent {
    const event = headers['x-gitea-event'] ?? headers['X-Gitea-Event'];
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
      case 'push':
        // Gitea has no separate workflow_run event today; surface push
        // as 'unknown' so callers can opt into custom handling without
        // misclassifying it as a CI run.
        return { kind: 'unknown', raw: json };
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

function parseRepo(full: string): { owner: string; name: string } {
  const [owner, name] = full.split('/');
  if (!owner || !name) throw new Error(`invalid repoFullName: ${full}`);
  return { owner, name };
}

function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

function prState(p: any): 'open' | 'closed' | 'merged' {
  if (p.merged) return 'merged';
  if (p.state === 'closed') return 'closed';
  return 'open';
}

function mapStatus(s: string): FileChangeStatus {
  if (s === 'added' || s === 'copied') return 'added';
  if (s === 'removed' || s === 'deleted') return 'removed';
  if (s === 'renamed') return 'renamed';
  return 'modified';
}
