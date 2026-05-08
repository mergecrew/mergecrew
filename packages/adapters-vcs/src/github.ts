import { createAppAuth } from '@octokit/auth-app';
import { Octokit } from '@octokit/rest';
import { execa } from 'execa';
import crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type {
  ConnectedRepoRef,
  MergeOpts,
  MergeResult,
  PullRequest,
  PullRequestOpts,
  VcsEvent,
  VcsProvider,
} from './types.js';

interface GitHubProviderConfig {
  appId: string;
  privateKey: string;
  clientId?: string;
  clientSecret?: string;
}

export class GitHubProvider implements VcsProvider {
  readonly id = 'github' as const;
  private auth: ReturnType<typeof createAppAuth>;
  private appId: string;
  private privateKey: string;

  constructor(cfg: GitHubProviderConfig) {
    this.appId = cfg.appId;
    this.privateKey = cfg.privateKey;
    this.auth = createAppAuth({ appId: cfg.appId, privateKey: cfg.privateKey, clientId: cfg.clientId, clientSecret: cfg.clientSecret });
  }

  // ─── tokens ─────────────────────────────────────────────────────────────

  private async tokenFor(installationId: string): Promise<string> {
    const r: any = await this.auth({ type: 'installation', installationId: Number(installationId) });
    return r.token;
  }

  private async kit(installationId: string): Promise<Octokit> {
    const token = await this.tokenFor(installationId);
    return new Octokit({ auth: token });
  }

  private async cloneUrl(repoFullName: string, installationId: string): Promise<string> {
    const token = await this.tokenFor(installationId);
    return `https://x-access-token:${token}@github.com/${repoFullName}.git`;
  }

  // ─── workspace ──────────────────────────────────────────────────────────

  async cloneIntoWorkspace(repo: ConnectedRepoRef, ref: string, dest: string): Promise<void> {
    await fs.mkdir(path.dirname(dest), { recursive: true });
    const url = await this.cloneUrl(repo.repoFullName, repo.installationId);
    await execa('git', ['clone', '--depth', '50', '--filter=blob:none', '--branch', ref, url, dest], {
      stdio: 'inherit',
      env: gitEnv(),
    });
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
    const kit = await this.kit(repo.installationId);
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
    const kit = await this.kit(repo.installationId);
    const { owner, name } = parseRepo(repo.repoFullName);
    await kit.issues.createComment({ owner, repo: name, issue_number: prNumber, body });
  }

  async mergePullRequest(
    repo: ConnectedRepoRef,
    prNumber: number,
    opts: MergeOpts,
  ): Promise<MergeResult> {
    const kit = await this.kit(repo.installationId);
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
    const kit = await this.kit(repo.installationId);
    const { owner, name } = parseRepo(repo.repoFullName);
    const pr = await kit.pulls.get({ owner, repo: name, pull_number: prNumber });
    const mergeSha = pr.data.merge_commit_sha;
    if (!mergeSha) throw new Error(`PR #${prNumber} not merged`);
    const branch = `mergecrew/revert-${prNumber}-${shortSha(mergeSha)}`;

    const tmp = await fs.mkdtemp(path.join(process.env.TMPDIR ?? '/tmp', 'mergecrew-revert-'));
    try {
      const url = await this.cloneUrl(repo.repoFullName, repo.installationId);
      await execa('git', ['clone', '--depth', '50', url, tmp], { env: gitEnv() });
      await execa('git', ['fetch', 'origin', repo.defaultBranch], { cwd: tmp, env: gitEnv() });
      await execa('git', ['checkout', repo.defaultBranch], { cwd: tmp, env: gitEnv() });
      await execa('git', ['checkout', '-b', branch], { cwd: tmp, env: gitEnv() });
      await execa('git', ['revert', '--no-edit', '-m', '1', mergeSha], { cwd: tmp, env: gitEnv() });
      await execa('git', ['push', '-u', 'origin', branch], { cwd: tmp, env: gitEnv() });

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
    const kit = await this.kit(repo.installationId);
    const { owner, name } = parseRepo(repo.repoFullName);
    await kit.pulls.update({ owner, repo: name, pull_number: prNumber, state: 'closed' });
  }

  async listOpenPullRequests(repo: ConnectedRepoRef): Promise<PullRequest[]> {
    const kit = await this.kit(repo.installationId);
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
    const kit = await this.kit(repo.installationId);
    const { owner, name } = parseRepo(repo.repoFullName);
    const r = await kit.repos.get({ owner, repo: name });
    return r.data.default_branch;
  }

  async getFileAt(
    repo: ConnectedRepoRef,
    ref: string,
    filepath: string,
  ): Promise<{ contentBase64: string }> {
    const kit = await this.kit(repo.installationId);
    const { owner, name } = parseRepo(repo.repoFullName);
    const r = await kit.repos.getContent({ owner, repo: name, path: filepath, ref });
    const data = r.data as any;
    if (Array.isArray(data) || data.type !== 'file' || typeof data.content !== 'string') {
      throw new Error(`not a file or unsupported: ${filepath}`);
    }
    return { contentBase64: data.content };
  }

  // ─── webhooks ───────────────────────────────────────────────────────────

  async verifyWebhookSignature(
    headers: Record<string, string>,
    body: Buffer,
    secret: string,
  ): Promise<boolean> {
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
