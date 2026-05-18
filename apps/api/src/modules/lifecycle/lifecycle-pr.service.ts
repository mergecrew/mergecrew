import { Injectable } from '@nestjs/common';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { applyGraphEdits, type GraphEdit } from '@mergecrew/config-yaml';
import { GitHubProvider, getGitHubAppCredentials } from '@mergecrew/adapters-vcs';
import { effectiveBaseBranch } from '@mergecrew/db';
import { NotFoundError, ValidationError } from '@mergecrew/domain';
import { PrismaService } from '../../common/prisma.service.js';
import { TenantContextService } from '../../common/tenant-context.service.js';

export interface LifecyclePrResult {
  prNumber: number;
  prUrl: string;
  branch: string;
  baseHash: string;
}

export interface LifecyclePrStale {
  stale: true;
  currentHash: string;
}

@Injectable()
export class LifecyclePrService {
  constructor(
    private prisma: PrismaService,
    private tenant: TenantContextService,
  ) {}

  /**
   * Open a PR against `mergecrew.yaml` carrying a list of graph edits.
   *
   * Lifecycle changes go through human review — this is the V2.1 phase 3
   * counterpart to the runner's code PRs (#196). The CST edit primitives in
   * @mergecrew/config-yaml preserve comments and ordering so the diff is
   * minimal, and the PR branch prefix `mergecrew/lifecycle/` is distinct
   * from the runner's `mergecrew/` branches so reviewers can tell them
   * apart.
   *
   * Conflict handling: the caller passes `baseHash` (the SHA-256 of the
   * mergecrew.yaml they were viewing). If the file in the default branch
   * has changed since, we return `{stale: true, currentHash}` so the UI
   * can refresh instead of silently overwriting.
   */
  async openLifecycleEditPr(
    orgSlug: string,
    projectSlug: string,
    edits: GraphEdit[],
    baseHash: string | null,
  ): Promise<LifecyclePrResult | LifecyclePrStale> {
    if (!Array.isArray(edits) || edits.length === 0) {
      throw new ValidationError('at least one edit is required');
    }
    const t = this.tenant.require();
    const project = await this.prisma.withTenant(t.organizationId, (tx) =>
      tx.project.findFirst({
        where: { slug: projectSlug, organizationId: t.organizationId },
        include: { connectedRepo: true },
      }),
    );
    if (!project) throw new NotFoundError('project not found');
    const repo = project.connectedRepo;
    if (!repo) {
      throw new ValidationError(
        'no repository connected — install the GitHub App and connect a repo first',
      );
    }
    if (repo.vcsProvider !== 'github') {
      throw new ValidationError(
        `lifecycle PRs only support github today; this repo uses ${repo.vcsProvider}`,
      );
    }
    const creds = getGitHubAppCredentials();
    if (!creds) {
      throw new ValidationError(
        'lifecycle PRs require GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY',
      );
    }

    const vcs = new GitHubProvider(creds);
    const baseBranch = effectiveBaseBranch(repo);
    const repoRef = {
      installationId: repo.installationId,
      repoId: repo.repoId ?? undefined,
      repoFullName: repo.repoFullName,
      defaultBranch: baseBranch,
    };

    const branch = `mergecrew/lifecycle/${projectSlug}-${shortTimestamp()}`;
    const workspace = await mkdtemp(path.join(tmpdir(), 'mergecrew-lifecycle-pr-'));

    try {
      await vcs.cloneIntoWorkspace(repoRef, baseBranch, workspace);

      const yamlPath = path.join(workspace, 'mergecrew.yaml');
      let source: string;
      try {
        source = await readFile(yamlPath, 'utf8');
      } catch {
        throw new ValidationError(
          'mergecrew.yaml not found at the repo root — initialize one before editing the lifecycle from the graph',
        );
      }

      const currentHash = sha256(source);
      if (baseHash && baseHash !== currentHash) {
        return { stale: true, currentHash };
      }

      const result = applyGraphEdits(source, edits);
      if (result.yaml === source) {
        throw new ValidationError(
          'edits produced no change — refresh the graph and try again',
        );
      }

      await vcs.createBranch(workspace, branch, baseBranch);
      await writeFile(yamlPath, result.yaml, 'utf8');

      await vcs.commit(workspace, {
        message: result.summary,
        authorName: 'Mergecrew Bot',
        authorEmail: `mergecrew@${t.organizationId}.mergecrew.dev`,
      });
      await vcs.push(workspace, branch);

      const pr = await vcs.openPullRequest(repoRef, {
        head: branch,
        base: baseBranch,
        title: `chore(lifecycle): ${result.summary}`,
        body: buildPrBody({
          orgSlug,
          projectSlug,
          summary: result.summary,
          edits,
          before: source,
          after: result.yaml,
        }),
      });

      return {
        prNumber: pr.number,
        prUrl: pr.url,
        branch: pr.branch,
        baseHash: currentHash,
      };
    } finally {
      await rm(workspace, { recursive: true, force: true }).catch(() => {});
    }
  }

  /**
   * Hash of the current mergecrew.yaml on the default branch. The UI calls
   * this when it opens the editor and passes the value back as `baseHash`
   * on save, so we can reject stale writes.
   */
  async currentBaseHash(projectSlug: string): Promise<{ baseHash: string | null }> {
    const t = this.tenant.require();
    const project = await this.prisma.withTenant(t.organizationId, (tx) =>
      tx.project.findFirst({
        where: { slug: projectSlug, organizationId: t.organizationId },
        include: { connectedRepo: true },
      }),
    );
    if (!project) throw new NotFoundError('project not found');
    const repo = project.connectedRepo;
    if (!repo || repo.vcsProvider !== 'github') return { baseHash: null };
    const creds = getGitHubAppCredentials();
    if (!creds) {
      return { baseHash: null };
    }
    const vcs = new GitHubProvider(creds);
    try {
      const baseBranch = effectiveBaseBranch(repo);
      const file = await vcs.getFileAt(
        {
          installationId: repo.installationId,
          repoId: repo.repoId ?? undefined,
          repoFullName: repo.repoFullName,
          defaultBranch: baseBranch,
        },
        baseBranch,
        'mergecrew.yaml',
      );
      const source = Buffer.from(file.contentBase64, 'base64').toString('utf8');
      return { baseHash: sha256(source) };
    } catch {
      return { baseHash: null };
    }
  }
}

function sha256(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

function shortTimestamp(): string {
  // Compact, lexicographically-sortable, branch-name-safe timestamp.
  return new Date().toISOString().replace(/[:.]/g, '-').replace(/Z$/, '');
}

function buildPrBody(args: {
  orgSlug: string;
  projectSlug: string;
  summary: string;
  edits: GraphEdit[];
  before: string;
  after: string;
}): string {
  const lifecycleUrl = `${appBaseUrl()}/orgs/${args.orgSlug}/projects/${args.projectSlug}/lifecycle`;
  const editLines = args.edits.map((e) => `- ${describeEdit(e)}`).join('\n');
  const diff = unifiedDiff(args.before, args.after, 'mergecrew.yaml');
  return [
    '<!-- mergecrew lifecycle PR -->',
    '',
    'Lifecycle change from the visual editor.',
    '',
    `**Summary:** ${args.summary}`,
    '',
    '**Edits:**',
    editLines,
    '',
    `[Open in lifecycle editor](${lifecycleUrl})`,
    '',
    '<details><summary>YAML diff</summary>',
    '',
    '```diff',
    diff,
    '```',
    '',
    '</details>',
  ].join('\n');
}

function describeEdit(e: GraphEdit): string {
  switch (e.kind) {
    case 'rename_workflow':
      return `rename workflow \`${e.from}\` → \`${e.to}\``;
    case 'add_edge':
      return `add edge \`${e.from}\` → \`${e.to}\``;
    case 'remove_edge':
      return `remove edge \`${e.from}\` → \`${e.to}\``;
    case 'add_agent':
      return `add agent \`${e.agent}\` to workflow \`${e.workflow}\``;
    case 'remove_agent':
      return `remove agent \`${e.agent}\` from workflow \`${e.workflow}\``;
    default: {
      const _exhaustive: never = e;
      void _exhaustive;
      return 'unknown edit';
    }
  }
}

function appBaseUrl(): string {
  return (process.env.MERGECREW_WEB_URL ?? 'http://localhost:3000').replace(/\/$/, '');
}

// Minimal unified-diff renderer scoped to two strings of one file. Avoids
// adding a `diff` dep for what's essentially a presentational nicety in the
// PR body. For mergecrew.yaml — a few KB at most — a quadratic LCS is fine.
function unifiedDiff(before: string, after: string, filename: string): string {
  const a = before.split('\n');
  const b = after.split('\n');
  const lcs = lcsTable(a, b);
  const ops: { tag: '=' | '-' | '+'; line: string; ai?: number; bi?: number }[] = [];
  let i = a.length;
  let j = b.length;
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) {
      ops.push({ tag: '=', line: a[i - 1]!, ai: i - 1, bi: j - 1 });
      i--;
      j--;
    } else if (lcs[i - 1]![j]! >= lcs[i]![j - 1]!) {
      ops.push({ tag: '-', line: a[i - 1]!, ai: i - 1 });
      i--;
    } else {
      ops.push({ tag: '+', line: b[j - 1]!, bi: j - 1 });
      j--;
    }
  }
  while (i > 0) {
    ops.push({ tag: '-', line: a[i - 1]!, ai: i - 1 });
    i--;
  }
  while (j > 0) {
    ops.push({ tag: '+', line: b[j - 1]!, bi: j - 1 });
    j--;
  }
  ops.reverse();

  // Group into hunks of changed lines + 3 lines of context on either side.
  const context = 3;
  const out: string[] = [`--- a/${filename}`, `+++ b/${filename}`];
  let k = 0;
  while (k < ops.length) {
    if (ops[k]!.tag === '=') {
      k++;
      continue;
    }
    let start = Math.max(0, k - context);
    let end = k;
    while (end < ops.length) {
      if (ops[end]!.tag !== '=') {
        end++;
        continue;
      }
      let runEnd = end;
      while (runEnd < ops.length && ops[runEnd]!.tag === '=') runEnd++;
      if (runEnd - end >= context * 2 || runEnd === ops.length) {
        end = Math.min(ops.length, end + context);
        break;
      }
      end = runEnd;
    }
    let oldStart = -1;
    let newStart = -1;
    let oldLines = 0;
    let newLines = 0;
    const body: string[] = [];
    for (let m = start; m < end; m++) {
      const op = ops[m]!;
      if (op.tag === '=' || op.tag === '-') {
        if (oldStart < 0 && op.ai !== undefined) oldStart = op.ai;
        oldLines++;
      }
      if (op.tag === '=' || op.tag === '+') {
        if (newStart < 0 && op.bi !== undefined) newStart = op.bi;
        newLines++;
      }
      body.push((op.tag === '=' ? ' ' : op.tag) + op.line);
    }
    out.push(`@@ -${(oldStart < 0 ? 0 : oldStart) + 1},${oldLines} +${(newStart < 0 ? 0 : newStart) + 1},${newLines} @@`);
    out.push(...body);
    k = end;
  }
  return out.join('\n');
}

function lcsTable(a: string[], b: string[]): number[][] {
  const t: number[][] = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      if (a[i - 1] === b[j - 1]) t[i]![j] = t[i - 1]![j - 1]! + 1;
      else t[i]![j] = Math.max(t[i - 1]![j]!, t[i]![j - 1]!);
    }
  }
  return t;
}
