import { promises as fs } from 'node:fs';
import path from 'node:path';
import { execa } from 'execa';
import { ValidationError } from '@mergecrew/domain';
import type { AnySkill } from '../types.js';
import { resolveInWorkspace } from '../workspace.js';

async function currentBranch(workspacePath: string): Promise<string | null> {
  try {
    const r = await execa('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: workspacePath,
      reject: false,
    });
    const s = (r.stdout ?? '').trim();
    return s && s !== 'HEAD' ? s : null;
  } catch {
    return null;
  }
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
    const abs = resolveInWorkspace(ctx.workspacePath, input.path);
    const buf = await fs.readFile(abs);
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
    const abs = resolveInWorkspace(ctx.workspacePath, input.path);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, input.content, 'utf8');
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
    const root = resolveInWorkspace(ctx.workspacePath, input.dir ?? '.');
    const max = input.max ?? 500;
    const out: string[] = [];
    async function walk(dir: string) {
      if (out.length >= max) return;
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const e of entries) {
        if (e.name === 'node_modules' || e.name === '.git' || e.name === '.next' || e.name === 'dist') continue;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) await walk(full);
        else out.push(path.relative(ctx.workspacePath!, full));
        if (out.length >= max) return;
      }
    }
    await walk(root);
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
    const max = input.max ?? 200;
    const re = input.regex
      ? new RegExp(input.query, 'm')
      : new RegExp(escapeRegex(input.query), 'i');
    const matches: { path: string; line: number; preview: string }[] = [];
    await walk(ctx.workspacePath, async (full) => {
      if (matches.length >= max) return false;
      const rel = path.relative(ctx.workspacePath!, full);
      try {
        const buf = await fs.readFile(full, 'utf8');
        const lines = buf.split('\n');
        for (let i = 0; i < lines.length; i++) {
          if (re.test(lines[i] ?? '')) {
            matches.push({ path: rel, line: i + 1, preview: lines[i]!.slice(0, 240) });
            if (matches.length >= max) return false;
          }
        }
      } catch {
        /* binary or unreadable */
      }
      return true;
    });
    return { output: { matches }, brief: `${matches.length} hits` };
  },
};

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
    const sha = await ctx.adapters.vcs.commit(ctx.workspacePath, {
      message: subject,
      authorName: 'Mergecrew Bot',
      authorEmail: `mergecrew@${ctx.organizationId}.mergecrew.dev`,
    });
    const branch = await currentBranch(ctx.workspacePath);
    return {
      output: { sha, branch, message: subject },
      brief: `commit ${sha.slice(0, 7)} ${subject}`,
    };
  },
};

const repoCreateBranch: AnySkill = {
  name: 'repo.git.create_branch',
  description: 'Create a new branch from the current HEAD.',
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
    await ctx.adapters.vcs.createBranch(ctx.workspacePath, input.name, input.from ?? 'HEAD');
    return { output: { branch: input.name }, brief: `branch ${input.name}` };
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
    await ctx.adapters.vcs.push(ctx.workspacePath, branch);
    const pr = await ctx.adapters.vcs.openPullRequest(connectedRepo, {
      head: branch,
      base: input.base ?? connectedRepo.basePrBranch ?? connectedRepo.defaultBranch,
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

async function walk(dir: string, visit: (full: string) => Promise<boolean>): Promise<void> {
  const stack: string[] = [dir];
  while (stack.length) {
    const cur = stack.pop()!;
    let entries;
    try {
      entries = await fs.readdir(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.name === 'node_modules' || e.name === '.git' || e.name === '.next' || e.name === 'dist') continue;
      const full = path.join(cur, e.name);
      if (e.isDirectory()) stack.push(full);
      else {
        const cont = await visit(full);
        if (cont === false) return;
      }
    }
  }
}
