import type {
  CreateIssueInput,
  Issue,
  ListIssuesQuery,
  TrackerProvider,
} from './types.js';

interface LinearProviderConfig {
  apiKey: string;
  teamId?: string;
}

const ENDPOINT = 'https://api.linear.app/graphql';

export class LinearProvider implements TrackerProvider {
  readonly id = 'linear' as const;
  constructor(private cfg: LinearProviderConfig) {}

  private async gql<T = any>(query: string, variables?: any): Promise<T> {
    const r = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { authorization: this.cfg.apiKey, 'content-type': 'application/json' },
      body: JSON.stringify({ query, variables }),
    });
    if (!r.ok) throw new Error(`linear ${r.status}: ${await r.text()}`);
    const j = (await r.json()) as any;
    if (j.errors) throw new Error(`linear gql: ${JSON.stringify(j.errors)}`);
    return j.data as T;
  }

  async listIssues(q: ListIssuesQuery): Promise<Issue[]> {
    const data = await this.gql<{ issues: { nodes: any[] } }>(
      `query($first: Int!, $filter: IssueFilter) {
        issues(first: $first, filter: $filter, orderBy: updatedAt) {
          nodes { id title description state { name } url labels { nodes { name } } createdAt }
        }
      }`,
      {
        first: q.max ?? 50,
        filter: q.status ? { state: { name: { eq: q.status } } } : null,
      },
    );
    return data.issues.nodes.map((n) => ({
      id: n.id,
      title: n.title,
      body: n.description ?? '',
      status: n.state?.name,
      url: n.url,
      labels: (n.labels?.nodes ?? []).map((l: any) => l.name),
      createdAt: n.createdAt,
    }));
  }

  async createIssue(input: CreateIssueInput): Promise<Issue> {
    const teamId = this.cfg.teamId ?? (await this.firstTeamId());
    const data = await this.gql<{ issueCreate: { issue: any } }>(
      `mutation($input: IssueCreateInput!) {
        issueCreate(input: $input) { issue { id title description state { name } url createdAt } }
      }`,
      { input: { teamId, title: input.title, description: input.body, labelIds: [] } },
    );
    const n = data.issueCreate.issue;
    return {
      id: n.id,
      title: n.title,
      body: n.description ?? '',
      status: n.state?.name,
      url: n.url,
      labels: input.labels ?? [],
      createdAt: n.createdAt,
    };
  }

  async commentIssue(id: string, body: string): Promise<void> {
    await this.gql(
      `mutation($input: CommentCreateInput!) { commentCreate(input: $input) { success } }`,
      { input: { issueId: id, body } },
    );
  }

  private async firstTeamId(): Promise<string> {
    const data = await this.gql<{ teams: { nodes: any[] } }>(
      `query { teams(first: 1) { nodes { id } } }`,
    );
    const id = data.teams.nodes[0]?.id;
    if (!id) throw new Error('no team for Linear API key');
    return id;
  }
}
