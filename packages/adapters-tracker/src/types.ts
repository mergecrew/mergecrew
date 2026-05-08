export interface Issue {
  id: string;
  title: string;
  body?: string;
  status?: string;
  url?: string;
  labels: string[];
  createdAt: string;
}

export interface ListIssuesQuery {
  status?: string;
  max?: number;
}

export interface CreateIssueInput {
  title: string;
  body: string;
  labels?: string[];
}

export interface TrackerProvider {
  readonly id: 'linear' | 'github-issues';
  listIssues(q: ListIssuesQuery): Promise<Issue[]>;
  createIssue(input: CreateIssueInput): Promise<Issue>;
  commentIssue(id: string, body: string): Promise<void>;
}
