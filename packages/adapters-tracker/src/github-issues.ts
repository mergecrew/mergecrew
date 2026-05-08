import { Octokit } from '@octokit/rest';
import type {
  CreateIssueInput,
  Issue,
  ListIssuesQuery,
  TrackerProvider,
} from './types.js';

interface GitHubIssuesConfig {
  installationToken: string;
  repoFullName: string;
}

export class GitHubIssuesProvider implements TrackerProvider {
  readonly id = 'github-issues' as const;
  private kit: Octokit;
  private owner: string;
  private name: string;

  constructor(private cfg: GitHubIssuesConfig) {
    this.kit = new Octokit({ auth: cfg.installationToken });
    const [owner, name] = cfg.repoFullName.split('/');
    if (!owner || !name) throw new Error(`bad repoFullName ${cfg.repoFullName}`);
    this.owner = owner;
    this.name = name;
  }

  async listIssues(q: ListIssuesQuery): Promise<Issue[]> {
    const r = await this.kit.issues.listForRepo({
      owner: this.owner,
      repo: this.name,
      state: q.status === 'closed' ? 'closed' : 'open',
      per_page: q.max ?? 50,
    });
    return r.data
      .filter((i: any) => !i.pull_request)
      .map((i: any) => ({
        id: String(i.number),
        title: i.title,
        body: i.body ?? '',
        status: i.state,
        url: i.html_url,
        labels: (i.labels ?? []).map((l: any) => (typeof l === 'string' ? l : l.name)),
        createdAt: i.created_at,
      }));
  }

  async createIssue(input: CreateIssueInput): Promise<Issue> {
    const r = await this.kit.issues.create({
      owner: this.owner,
      repo: this.name,
      title: input.title,
      body: input.body,
      labels: input.labels,
    });
    return {
      id: String(r.data.number),
      title: r.data.title,
      body: r.data.body ?? '',
      status: r.data.state,
      url: r.data.html_url,
      labels: input.labels ?? [],
      createdAt: r.data.created_at,
    };
  }

  async commentIssue(id: string, body: string): Promise<void> {
    await this.kit.issues.createComment({
      owner: this.owner,
      repo: this.name,
      issue_number: Number(id),
      body,
    });
  }
}
