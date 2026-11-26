import { ValidationError } from '@mergecrew/domain';
import {
  RUN_BRANCH_PREFIX,
  assertValidBranchName,
  gitCurrentBranch,
  gitEnsureRunBranch,
} from '@mergecrew/adapters-vcs';
import type { AnySkill, SkillExecutionContext } from '../types.js';
import {
  isGitMetadataPath,
  readWorkspaceFile,
  walkWorkspace,
  writeWorkspaceFile,
} from '../workspace.js';

/** Directories never listed / searched. */
const SKIP_DIRS: ReadonlySet<string> = new Set(['node_modules', '.next', 'dist']);

/** Max bytes `repo.search` reads per file. */
const SEARCH_MAX_FILE_BYTES = 2 * 1024 * 1024;

/**
 * Branch the run's commits land on. The runner creates it right after
 * the clone; the commit skill re-asserts it so agent commits can never
 * land on the default branch.
 */
export function runBranchName(runId: string | undefined): string {
  const id = (runId ?? '').replace(/[^A-Za-z0-9_-]/g, '-').replace(/^-+/, '').slice(0, 64) || 'run';
  return `${RUN_BRANCH_PREFIX}${id}`;
}

/** Agent-chosen branch names are namespaced under `mergecrew/`. */
export function normalizeAgentBranchName(name: unknown): string {
  if (typeof name !== 'string' || name.trim().length === 0) {
    throw new ValidationError('branch name must be a non-empty string');
  }
  const trimmed = name.trim();
  const full = trimmed.startsWith(RUN_BRANCH_PREFIX) ? trimmed : `${RUN_BRANCH_PREFIX}${trimmed}`;
  try {
    assertValidBranchName(full);
  } catch (err) {
    throw new ValidationError((err as Error).message);
  }
  return full;
}

async function currentBranch(ctx: SkillExecutionContext): Promise<string | null> {
  if (!ctx.workspacePath) return null;
  // Supervisor-side safe git, not the sandbox: the sandbox's answer is
  // tenant-influenced and becomes the branch the runner pushes.
  return gitCurrentBranch(ctx.workspacePath).catch(() => null);
}

const repoReadFile: AnySkill = {
  name: 'repo.read_file',
  description: 'Read a file from the repository working tree.',
  inputSchema: {
    type: 'object',
    properties: { path: { type: 'string' } },
    required: ['path'],
    additionalProperties: false,
  },
  sideEffectClass: 'read',
  capabilities: ['fs.read'],
  async execute(input: any, ctx) {
    if (!ctx.workspacePath) throw new ValidationError('repo.read_file: workspacePath required');
    // Symlink-safe: realpath-confined, O_NOFOLLOW, git metadata denied.
    const buf = await readWorkspaceFile(ctx.workspacePath, input.path);
    const content = buf.toString('utf8');
    return { output: { content }, brief: `read ${input.path} (${buf.length} bytes)` };
  },
};

const repoWriteFile: AnySkill = {
  name: 'repo.write_file',
  description: 'Write the full contents of a file in the repository working tree.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string' },
      content: { type: 'string' },
    },
    required: ['path', 'content'],
    additionalProperties: false,
  },
  sideEffectClass: 'write_workspace',
  capabilities: ['fs.write'],
  async execute(input: any, ctx) {
    if (!ctx.workspacePath) throw new ValidationError('repo.write_file: workspacePath required');
    if (typeof input.content !== 'string') throw new ValidationError('repo.write_file: content must be a string');
    // Symlink-safe: parent realpath-confined, final component O_NOFOLLOW,
    // no hard links, git metadata denied.
    await writeWorkspaceFile(ctx.workspacePath, input.path, input.content);
    return {
      output: { path: input.path, bytes: Buffer.byteLength(input.content, 'utf8') },
      brief: `wrote ${input.path}`,
    };
  },
};

const repoListPaths: AnySkill = {
  name: 'repo.list_paths',
  description: 'List repository paths matching a glob, scoped to a sub-directory.',
  inputSchema: {
    type: 'object',
    properties: { dir: { type: 'string' }, max: { type: 'integer' } },
    additionalProperties: false,
  },
  sideEffectClass: 'read',
  capabilities: ['fs.read'],
  async execute(input: any, ctx) {
    if (!ctx.workspacePath) throw new ValidationError('repo.list_paths: workspacePath required');
    const max = input.max ?? 500;
    const out: string[] = [];
    // Never follows symlinks (files or directories); skips git metadata.
    await walkWorkspace(
      ctx.workspacePath,
      input.dir ?? '.',
      async (rel) => {
        if (out.length >= max) return false;
        out.push(rel);
        return out.length < max;
      },
      { skipDirs: SKIP_DIRS },
    );
    return { output: { paths: out }, brief: `${out.length} paths` };
  },
};

const repoSearch: AnySkill = {
  name: 'repo.search',
  description: 'Search file contents for a literal substring or regex.',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string' },
      regex: { type: 'boolean' },
      max: { type: 'integer' },
    },
    required: ['query'],
    additionalProperties: false,
  },
  sideEffectClass: 'read',
  capabilities: ['fs.read'],
  async execute(input: any, ctx) {
    if (!ctx.workspacePath) throw new ValidationError('repo.search: workspacePath required');
    const ws = ctx.workspacePath;
    const max = input.max ?? 200;
    const re = input.regex
      ? new RegExp(input.query, 'm')
      : new RegExp(escapeRegex(input.query), 'i');
    const matches: { path: string; line: number; preview: string }[] = [];
    await walkWorkspace(
      ws,
      '.',
      async (rel) => {
        if (matches.length >= max) return false;
        let buf: string;
        try {
          // Each file is re-opened through the symlink-safe reader.
          buf = (await readWorkspaceFile(ws, rel, { maxBytes: SEARCH_MAX_FILE_BYTES })).toString('utf8');
        } catch {
          return true; /* binary, too large, unreadable or swapped */
        }
        const lines = buf.split('\n');
        for (let i = 0; i < lines.length; i++) {
          if (re.test(lines[i] ?? '')) {
            matches.push({ path: rel, line: i + 1, preview: lines[i]!.slice(0, 240) });
            if (matches.length >= max) return false;
          }
        }
        return true;
      },
      { skipDirs: SKIP_DIRS },
    );
    return { output: { matches }, brief: `${matches.length} hits` };
  },
};

/**
 * Staged-path guard applied inside the commit (after `git add -A`, before
 * the commit object is written). Git metadata can never be committed;
 * the runner adds its hard-block policy via `ctx.config.commitGuard`.
 */
function buildCommitGuard(ctx: SkillExecutionContext): (paths: string[]) => Promise<void> {
  const extra = (ctx.config as { commitGuard?: (paths: string[]) => void | Promise<void> } | undefined)
    ?.commitGuard;
  return async (paths: string[]) => {
    const meta = paths.filter((p) => isGitMetadataPath(p));
    if (meta.length > 0) {
      throw new ValidationError(`repo.git.commit: refusing to commit git metadata: ${meta.slice(0, 5).join(', ')}`);
    }
    if (typeof extra === 'function') await extra(paths);
  };
}

const repoCommit: AnySkill = {
  name: 'repo.git.commit',
  description: 'Stage and commit current workspace changes.',
  inputSchema: {
    type: 'object',
    properties: {
      message: { type: 'string' },
      type: { type: 'string' },
      scope: { type: 'string' },
      paths: { type: 'array', items: { type: 'string' } },
    },
    required: ['message'],
    additionalProperties: false,
  },
  sideEffectClass: 'write_external',
  capabilities: ['git.commit'],
  async execute(input: any, ctx) {
    if (!ctx.adapters.vcs || !ctx.workspacePath)
      throw new ValidationError('repo.git.commit: vcs adapter and workspace required');
    const subject = input.type
      ? `${input.type}${input.scope ? `(${input.scope})` : ''}: ${input.message}`
      : input.message;
    // Never commit on the default branch / detached HEAD: make sure HEAD
    // is on a runner-owned `mergecrew/` branch first.
    await gitEnsureRunBranch(ctx.workspacePath, runBranchName(ctx.runId));
    const sha = await ctx.adapters.vcs.commit(ctx.workspacePath, {
      message: subject,
      authorName: 'Mergecrew Bot',
      authorEmail: `mergecrew@${ctx.organizationId}.mergecrew.dev`,
      guardStagedPaths: buildCommitGuard(ctx),
    });
    const branch = await currentBranch(ctx);
    return {
      output: { sha, branch, message: subject },
      brief: `commit ${sha.slice(0, 7)} ${subject}`,
    };
  },
};

const repoCreateBranch: AnySkill = {
  name: 'repo.git.create_branch',
  description:
    'Create a new branch (namespaced under mergecrew/) from the current HEAD, a local branch, or origin/<branch>.',
  inputSchema: {
    type: 'object',
    properties: { name: { type: 'string' }, from: { type: 'string' } },
    required: ['name'],
    additionalProperties: false,
  },
  sideEffectClass: 'write_workspace',
  capabilities: ['git.write'],
  async execute(input: any, ctx) {
    if (!ctx.adapters.vcs || !ctx.workspacePath)
      throw new ValidationError('repo.git.create_branch: vcs adapter and workspace required');
    const name = normalizeAgentBranchName(input.name);
    // `from` is resolved against a ref allowlist inside the adapter
    // (HEAD / local branch / origin/<branch>) and never reaches git as a
    // raw argument.
    try {
      await ctx.adapters.vcs.createBranch(ctx.workspacePath, name, input.from ?? 'HEAD');
    } catch (err: any) {
      if (err?.name === 'GitRefError') throw new ValidationError(err.message);
      throw err;
    }
    return { output: { branch: name }, brief: `branch ${name}` };
  },
};

const repoOpenPr: AnySkill = {
  name: 'repo.git.open_pr',
  description: 'Push the current branch and open a Pull Request.',
  inputSchema: {
    type: 'object',
    properties: {
      title: { type: 'string' },
      body: { type: 'string' },
      base: { type: 'string' },
    },
    required: ['title', 'body'],
    additionalProperties: false,
  },
  sideEffectClass: 'write_external',
  capabilities: ['git.write', 'net.outbound'],
  async execute(input: any, ctx) {
    if (!ctx.adapters.vcs || !ctx.workspacePath)
      throw new ValidationError('repo.git.open_pr: vcs adapter and workspace required');
    const { connectedRepo, branch } = readWorkspaceMeta(ctx);
    const configuredBase = connectedRepo.basePrBranch ?? connectedRepo.defaultBranch;
    const base = input.base ?? configuredBase;
    if (base !== configuredBase && base !== connectedRepo.defaultBranch) {
      throw new ValidationError(`repo.git.open_pr: base must be ${configuredBase}`);
    }
    // Refuses the base / default branch and anything outside mergecrew/.
    await ctx.adapters.vcs.push(ctx.workspacePath, branch, connectedRepo, {
      protectedBranches: [configuredBase, connectedRepo.defaultBranch],
    });
    const pr = await ctx.adapters.vcs.openPullRequest(connectedRepo, {
      head: branch,
      base,
      title: input.title,
      body: input.body,
    });
    return { output: pr, brief: `PR #${pr.number}` };
  },
};

const repoCommentPr: AnySkill = {
  name: 'repo.git.comment_pr',
  description: 'Post a comment on a Pull Request.',
  inputSchema: {
    type: 'object',
    properties: { number: { type: 'integer' }, body: { type: 'string' } },
    required: ['number', 'body'],
    additionalProperties: false,
  },
  sideEffectClass: 'write_external',
  capabilities: ['net.outbound'],
  async execute(input: any, ctx) {
    if (!ctx.adapters.vcs) throw new ValidationError('repo.git.comment_pr: vcs adapter required');
    const { connectedRepo } = readWorkspaceMeta(ctx);
    await ctx.adapters.vcs.commentOnPullRequest(connectedRepo, input.number, input.body);
    return { output: { ok: true }, brief: `commented on #${input.number}` };
  },
};

const repoRevertPr: AnySkill = {
  name: 'repo.git.revert_pr',
  description: 'Open a revert PR for a previously merged Pull Request.',
  inputSchema: {
    type: 'object',
    properties: { number: { type: 'integer' } },
    required: ['number'],
    additionalProperties: false,
  },
  sideEffectClass: 'write_external',
  capabilities: ['git.write', 'net.outbound'],
  async execute(input: any, ctx) {
    if (!ctx.adapters.vcs) throw new ValidationError('repo.git.revert_pr: vcs adapter required');
    const { connectedRepo } = readWorkspaceMeta(ctx);
    const r = await ctx.adapters.vcs.revertPullRequest(connectedRepo, input.number);
    return { output: r, brief: `revert PR #${input.number} → #${r.revertPrNumber}` };
  },
};

export const repoSkills: AnySkill[] = [
  repoReadFile,
  repoWriteFile,
  repoListPaths,
  repoSearch,
  repoCommit,
  repoCreateBranch,
  repoOpenPr,
  repoCommentPr,
  repoRevertPr,
];

// ─── helpers ─────────────────────────────────────────────────────────────────

function readWorkspaceMeta(ctx: any): {
  connectedRepo: {
    installationId: string;
    repoFullName: string;
    defaultBranch: string;
    basePrBranch?: string | null;
  };
  branch: string;
} {
  const cfg = ctx.config?.repoMeta as
    | { connectedRepo: any; branch: string }
    | undefined;
  if (!cfg) throw new ValidationError('skill config missing repoMeta');
  return cfg;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
