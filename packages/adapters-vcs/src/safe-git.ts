import { execa } from 'execa';
import { mkdtempSync, promises as fs, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Hardened git execution for the supervisor (runner / API) process.
 *
 * The supervisor holds every platform secret and runs git against
 * tenant-controlled working trees. Repo-local git configuration, hooks,
 * fsmonitor, filter / textconv drivers, credential helpers, includes,
 * alternates and `url.*.insteadOf` rewrites are all code-execution or
 * credential-exfiltration vectors, so every supervisor-side git call
 * goes through `runGit`, which:
 *
 *   1. runs with a minimal env allowlist — never the inherited process
 *      env (no KMS key, App key, DB URLs, LLM keys reach git or any
 *      helper it spawns);
 *   2. passes `-c` overrides that disable hooks, fsmonitor, external
 *      diff, credential helpers, pagers and non-HTTP(S) transports;
 *   3. before touching an existing repo, validates its `.git` directory
 *      structure and `.git/config` against a strict allowlist and
 *      refuses to run on anything unexpected (includes, hooks, filters,
 *      `core.*` command settings, remotes other than a clean HTTP(S)
 *      origin, alternates, `commondir`, gitfiles / symlinked `.git`);
 *   4. carries HTTP auth for a single invocation only, through
 *      `GIT_CONFIG_COUNT` env entries scoped to the remote's origin —
 *      the token is never written to `.git/config`, never put in a
 *      remote URL and never appears in argv (so it cannot leak into
 *      error messages or process listings).
 */

export class UnsafeGitRepoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsafeGitRepoError';
  }
}

export class GitRefError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GitRefError';
  }
}

/** Per-invocation HTTP auth. Sent as an `Authorization` header scoped to `origin`. */
export interface GitHttpAuth {
  /** Remote origin the header is scoped to, e.g. `https://github.com`. */
  origin: string;
  /** Full header value, e.g. `Basic <base64>`. */
  authorization: string;
}

export function basicAuth(origin: string, username: string, password: string): GitHttpAuth {
  return {
    origin: originOf(origin),
    authorization: `Basic ${Buffer.from(`${username}:${password}`, 'utf8').toString('base64')}`,
  };
}

function originOf(url: string): string {
  const u = new URL(url);
  return `${u.protocol}//${u.host}`;
}

// ─── environment ────────────────────────────────────────────────────────────

/**
 * Env vars git may inherit. Proxy + CA settings are needed for
 * operator-configured egress / GHES with private CAs. Everything else
 * — notably every secret the supervisor holds — is dropped.
 */
const PASSTHROUGH_ENV = [
  'PATH',
  'LANG',
  'LC_ALL',
  'TZ',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'GIT_SSL_CAINFO',
] as const;

let gitHome: string | null = null;
function emptyGitHome(): string {
  if (gitHome) return gitHome;
  gitHome = mkdtempSync(path.join(os.tmpdir(), 'mergecrew-git-home-'));
  return gitHome;
}

/**
 * Build the complete env for a git child process. `extra` is merged
 * last (author identity, per-call auth). Exported for tests.
 */
export function buildSafeGitEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const k of PASSTHROUGH_ENV) {
    const v = process.env[k];
    if (typeof v === 'string' && v.length > 0) env[k] = v;
  }
  if (!env.PATH) env.PATH = '/usr/local/bin:/usr/bin:/bin';
  if (!env.LANG) env.LANG = 'C.UTF-8';
  const home = emptyGitHome();
  Object.assign(env, {
    HOME: home,
    XDG_CONFIG_HOME: home,
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_ATTR_NOSYSTEM: '1',
    GIT_NO_REPLACE_OBJECTS: '1',
    // Partial clones would otherwise lazily fetch from `origin` without
    // auth (and with whatever URL the config holds).
    GIT_NO_LAZY_FETCH: '1',
    GIT_PROTOCOL_FROM_USER: '0',
    GIT_ASKPASS: '',
    SSH_ASKPASS: '',
    GIT_OPTIONAL_LOCKS: '0',
  });
  return { ...env, ...extra };
}

/** Env for invocations outside any repository (no discovery above the empty home). */
function neutralEnv(): Record<string, string> {
  return buildSafeGitEnv({ GIT_CEILING_DIRECTORIES: path.dirname(emptyGitHome()) });
}

function authEnv(auth: GitHttpAuth | undefined): Record<string, string> {
  if (!auth) return {};
  // URL-scoped so the header is only ever sent to the remote's origin.
  return {
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: `http.${auth.origin}/.extraheader`,
    GIT_CONFIG_VALUE_0: `Authorization: ${auth.authorization}`,
  };
}

/**
 * `-c` overrides applied to every invocation. Command-line config wins
 * over repo-local config for these keys; everything else dangerous is
 * rejected by `assertSafeGitDir` before git runs.
 */
export const SAFE_GIT_CONFIG: readonly string[] = [
  'core.hooksPath=/dev/null',
  'core.fsmonitor=false',
  'core.untrackedCache=false',
  'core.sshCommand=false',
  'core.askPass=',
  'core.pager=cat',
  'core.attributesFile=/dev/null',
  'credential.helper=',
  'protocol.allow=never',
  'protocol.https.allow=always',
  'protocol.http.allow=always',
  'protocol.file.allow=never',
  'protocol.ext.allow=never',
  'protocol.ssh.allow=never',
  'protocol.git.allow=never',
  'submodule.recurse=false',
  'fetch.recurseSubmodules=false',
  'commit.gpgSign=false',
  'tag.gpgSign=false',
  'gc.auto=0',
  'maintenance.auto=false',
  'http.sslVerify=true',
  'advice.detachedHead=false',
];

function configArgs(safeDirectory?: string): string[] {
  const out: string[] = [];
  for (const kv of SAFE_GIT_CONFIG) out.push('-c', kv);
  if (safeDirectory) out.push('-c', `safe.directory=${safeDirectory}`);
  return out;
}

// ─── repository validation ─────────────────────────────────────────────────

const BOOL_RE = /^(true|false|yes|no|on|off|1|0)$/i;

/** Allowlist of keys a runner-managed `.git/config` may contain. */
const ALLOWED_CONFIG: Array<{ re: RegExp; ok: (v: string | null, key: string) => boolean }> = [
  { re: /^core\.repositoryformatversion$/, ok: (v) => v === '0' || v === '1' },
  { re: /^core\.bare$/, ok: (v) => v === 'false' },
  { re: /^core\.(filemode|ignorecase|precomposeunicode|symlinks)$/, ok: (v) => v !== null && BOOL_RE.test(v) },
  { re: /^core\.logallrefupdates$/, ok: (v) => v !== null && (BOOL_RE.test(v) || v === 'always') },
  { re: /^remote\.origin\.url$/, ok: (v) => v !== null && isCleanHttpUrl(v) },
  { re: /^remote\.origin\.fetch$/, ok: (v) => v !== null && /^\+?refs\/[A-Za-z0-9._/*-]+:refs\/[A-Za-z0-9._/*-]+$/.test(v) },
  { re: /^remote\.origin\.promisor$/, ok: (v) => v !== null && BOOL_RE.test(v) },
  { re: /^remote\.origin\.partialclonefilter$/, ok: (v) => v !== null && /^(blob:none|blob:limit=\d+[kmg]?|tree:\d+)$/.test(v) },
  { re: /^remote\.origin\.tagopt$/, ok: (v) => v === '--no-tags' },
  { re: /^extensions\.partialclone$/, ok: (v) => v === 'origin' },
  { re: /^extensions\.objectformat$/, ok: (v) => v === 'sha1' || v === 'sha256' },
  { re: /^branch\.[^\n]+\.remote$/, ok: (v) => v === 'origin' },
  { re: /^branch\.[^\n]+\.merge$/, ok: (v) => v !== null && /^refs\/heads\/[^\s]+$/.test(v) },
];

export function isCleanHttpUrl(v: string): boolean {
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
  if (u.username || u.password) return false;
  if (u.search || u.hash) return false;
  return true;
}

/** Parse `git config --list --null` output into key/value pairs. */
function parseConfigList(raw: string): Array<{ key: string; value: string | null }> {
  const out: Array<{ key: string; value: string | null }> = [];
  for (const entry of raw.split('\0')) {
    if (!entry) continue;
    const nl = entry.indexOf('\n');
    if (nl < 0) out.push({ key: entry, value: null });
    else out.push({ key: entry.slice(0, nl), value: entry.slice(nl + 1) });
  }
  return out;
}

async function lstatOrNull(p: string) {
  return fs.lstat(p).catch((e: any) => (e?.code === 'ENOENT' ? null : Promise.reject(e)));
}

/** Files whose mere presence redirects git to state outside the workspace. */
const FORBIDDEN_GIT_FILES = [
  'commondir',
  'config.worktree',
  'objects/info/alternates',
  'objects/info/http-alternates',
];

/**
 * Validate the repository at `workspace` before the supervisor runs git
 * in it. Throws `UnsafeGitRepoError` on anything a tenant could have
 * planted to make git execute code, read other directories, or send
 * credentials elsewhere.
 */
export async function assertSafeGitDir(workspace: string): Promise<void> {
  const gitDir = path.join(workspace, '.git');
  const st = await lstatOrNull(gitDir);
  if (!st) throw new UnsafeGitRepoError(`not a git workspace: ${workspace}`);
  if (st.isSymbolicLink() || !st.isDirectory()) {
    throw new UnsafeGitRepoError('.git must be a real directory (gitfile / symlink refused)');
  }
  for (const rel of FORBIDDEN_GIT_FILES) {
    if (await lstatOrNull(path.join(gitDir, rel))) {
      throw new UnsafeGitRepoError(`unexpected .git/${rel} present`);
    }
  }
  for (const rel of ['objects', 'refs']) {
    const s = await lstatOrNull(path.join(gitDir, rel));
    if (!s || s.isSymbolicLink() || !s.isDirectory()) {
      throw new UnsafeGitRepoError(`.git/${rel} must be a real directory`);
    }
  }
  for (const rel of ['config', 'HEAD']) {
    const s = await lstatOrNull(path.join(gitDir, rel));
    if (!s || s.isSymbolicLink() || !s.isFile()) {
      throw new UnsafeGitRepoError(`.git/${rel} must be a regular file`);
    }
    if (s.size > 64 * 1024) throw new UnsafeGitRepoError(`.git/${rel} is unexpectedly large`);
  }
  const entries = await readConfigEntries(path.join(gitDir, 'config'));
  for (const { key, value } of entries) {
    const rule = ALLOWED_CONFIG.find((r) => r.re.test(key));
    if (!rule) throw new UnsafeGitRepoError(`.git/config contains a disallowed key: ${key}`);
    if (!rule.ok(value, key)) throw new UnsafeGitRepoError(`.git/config has a disallowed value for ${key}`);
  }
}

async function readConfigEntries(configPath: string): Promise<Array<{ key: string; value: string | null }>> {
  // `git config --file` never honours includes unless asked and never
  // executes anything — safe to point at a hostile file.
  const r = await execa(
    'git',
    [...configArgs(), 'config', '--file', configPath, '--no-includes', '--list', '--null'],
    { env: neutralEnv(), cwd: emptyGitHome(), extendEnv: false, reject: false, stdin: 'ignore' },
  );
  if (r.exitCode !== 0) {
    throw new UnsafeGitRepoError(`.git/config could not be parsed: ${String(r.stderr).slice(0, 200)}`);
  }
  return parseConfigList(String(r.stdout));
}

/**
 * Remove credentials from `remote.origin.url` (workspaces cloned before
 * tokens moved out of URLs) and drop `remote.origin.pushurl`. Only
 * touches `.git/config` when it is a regular file inside a real `.git`
 * directory. Returns true when something was rewritten.
 */
export async function scrubWorkspaceGitCredentials(workspace: string): Promise<boolean> {
  const gitDir = path.join(workspace, '.git');
  const st = await lstatOrNull(gitDir);
  if (!st || st.isSymbolicLink() || !st.isDirectory()) return false;
  const cfgPath = path.join(gitDir, 'config');
  const cst = await lstatOrNull(cfgPath);
  if (!cst || cst.isSymbolicLink() || !cst.isFile()) return false;
  const entries = await readConfigEntries(cfgPath);
  let changed = false;
  for (const { key, value } of entries) {
    if (!/^remote\.[^\n]+\.(url|pushurl)$/.test(key) || value === null) continue;
    let clean: string | null = null;
    try {
      const u = new URL(value);
      if (u.username || u.password) {
        u.username = '';
        u.password = '';
        clean = u.toString();
      }
    } catch {
      // Not URL-shaped (scp-style); might still carry a user. Leave it —
      // assertSafeGitDir will refuse to run on it.
    }
    if (key.endsWith('.pushurl')) {
      await gitConfigFile(cfgPath, ['--unset-all', key]);
      changed = true;
    } else if (clean !== null) {
      await gitConfigFile(cfgPath, [key, clean]);
      changed = true;
    }
  }
  return changed;
}

async function gitConfigFile(configPath: string, args: string[]): Promise<void> {
  await execa('git', [...configArgs(), 'config', '--file', configPath, ...args], {
    env: neutralEnv(),
    cwd: emptyGitHome(),
    extendEnv: false,
    stdin: 'ignore',
  });
}

// ─── execution ──────────────────────────────────────────────────────────────

export interface RunGitOpts {
  /** Repository working tree. When set, the repo is validated before git runs. */
  cwd?: string;
  /** Per-invocation HTTP auth (never persisted). */
  auth?: GitHttpAuth;
  /** Extra env (author identity). Must not carry secrets. */
  env?: Record<string, string>;
  /** Skip `assertSafeGitDir` (only for `clone`, where no repo exists yet). */
  skipRepoCheck?: boolean;
  timeoutMs?: number;
  maxBuffer?: number;
}

export interface GitResult {
  stdout: string;
  stderr: string;
}

/** Test seam: override the git binary (e.g. a fake that dumps its env). */
let gitBinary = 'git';
export function __setGitBinaryForTests(bin: string | null): void {
  gitBinary = bin ?? 'git';
}

/**
 * Run git with the hardened env + config. Throws on non-zero exit with
 * a message that never includes auth material.
 */
export async function runGit(args: string[], opts: RunGitOpts = {}): Promise<GitResult> {
  let safeDir: string | undefined;
  if (opts.cwd) {
    if (!opts.skipRepoCheck) await assertSafeGitDir(opts.cwd);
    safeDir = realpathSync(opts.cwd);
  }
  const env = buildSafeGitEnv({
    ...(opts.env ?? {}),
    ...authEnv(opts.auth),
    GIT_CEILING_DIRECTORIES: path.dirname(safeDir ?? emptyGitHome()),
  });
  const r = await execa(gitBinary, [...configArgs(safeDir), ...args], {
    cwd: opts.cwd ?? emptyGitHome(),
    env,
    extendEnv: false,
    reject: false,
    stdin: 'ignore',
    timeout: opts.timeoutMs ?? 10 * 60_000,
    maxBuffer: opts.maxBuffer ?? 64 * 1024 * 1024,
  });
  const stdout = typeof r.stdout === 'string' ? r.stdout : '';
  const stderr = typeof r.stderr === 'string' ? r.stderr : '';
  if (r.exitCode !== 0 || r.timedOut) {
    const sub = args.find((a) => !a.startsWith('-')) ?? 'git';
    throw new Error(
      `git ${sub} failed (exit ${r.exitCode ?? 'n/a'}${r.timedOut ? ', timed out' : ''}): ${redact(stderr, opts.auth).slice(0, 2000)}`,
    );
  }
  return { stdout, stderr };
}

function redact(s: string, auth?: GitHttpAuth): string {
  let out = s;
  if (auth) {
    const b64 = auth.authorization.replace(/^\S+\s+/, '');
    out = out.split(b64).join('***');
  }
  return out.replace(/(https?:\/\/)[^/@\s]+@/g, '$1***@');
}

// ─── ref validation ─────────────────────────────────────────────────────────

/**
 * Validate a branch name supplied by an agent / tenant data. Stricter
 * than `git check-ref-format --branch`: ASCII word chars, `.`, `_`, `-`,
 * `/` only; no leading `-` (option injection), no `..`, no `@{`, no
 * component starting with `.` or ending in `.lock`.
 */
export function assertValidBranchName(name: unknown): asserts name is string {
  if (typeof name !== 'string' || name.length === 0 || name.length > 200) {
    throw new GitRefError('branch name must be a non-empty string (max 200 chars)');
  }
  if (!/^[A-Za-z0-9._/-]+$/.test(name)) throw new GitRefError(`invalid branch name: ${name}`);
  if (name.startsWith('-') || name.startsWith('/') || name.endsWith('/') || name.endsWith('.')) {
    throw new GitRefError(`invalid branch name: ${name}`);
  }
  if (name.includes('..') || name.includes('//') || name.includes('@{') || name === 'HEAD' || name === '@') {
    throw new GitRefError(`invalid branch name: ${name}`);
  }
  for (const part of name.split('/')) {
    if (part.startsWith('.') || part.startsWith('-') || part.endsWith('.lock')) {
      throw new GitRefError(`invalid branch name: ${name}`);
    }
  }
}

/**
 * Validate `owner/name` (or `group/sub/name` for GitLab) before it is
 * interpolated into a remote URL.
 */
export function assertRepoFullName(full: string, opts: { allowNested?: boolean } = {}): void {
  const parts = typeof full === 'string' ? full.split('/') : [];
  const okCount = opts.allowNested ? parts.length >= 2 : parts.length === 2;
  if (!okCount || parts.some((p) => !/^[A-Za-z0-9_.-]+$/.test(p) || p === '.' || p === '..')) {
    throw new Error(`invalid repoFullName: ${full}`);
  }
}

/** Prefix every runner-created / runner-pushed branch carries. */
export const RUN_BRANCH_PREFIX = 'mergecrew/';

/**
 * Refuse to push anything but a `mergecrew/…` branch, and never a
 * protected / base / default branch even if it happens to match.
 */
export function assertPushableBranch(branch: string, protectedBranches: readonly string[] = []): void {
  assertValidBranchName(branch);
  const lowered = branch.toLowerCase();
  const protectedSet = new Set(
    [...protectedBranches, 'main', 'master', 'develop', 'production', 'release', 'trunk']
      .filter(Boolean)
      .map((b) => b.replace(/^refs\/heads\//, '').toLowerCase()),
  );
  if (protectedSet.has(lowered)) throw new GitRefError(`refusing to push protected branch: ${branch}`);
  if (!branch.startsWith(RUN_BRANCH_PREFIX) || branch.length <= RUN_BRANCH_PREFIX.length) {
    throw new GitRefError(`refusing to push non-${RUN_BRANCH_PREFIX} branch: ${branch}`);
  }
}

// ─── workspace operations shared by the git-backed adapters ────────────────

export interface CloneOpts {
  cleanUrl: string;
  ref: string;
  dest: string;
  auth?: GitHttpAuth;
  depth?: number;
}

/** Clone without persisting credentials, then validate the result. */
export async function gitClone(opts: CloneOpts): Promise<void> {
  assertValidBranchName(opts.ref);
  if (!isCleanHttpUrl(opts.cleanUrl)) throw new UnsafeGitRepoError('clone URL must be http(s) without credentials');
  await fs.mkdir(path.dirname(opts.dest), { recursive: true });
  await runGit(
    [
      'clone',
      '--template=',
      '--no-recurse-submodules',
      '--single-branch',
      '--no-tags',
      '--depth',
      String(opts.depth ?? 50),
      '--filter=blob:none',
      '--branch',
      opts.ref,
      '--',
      opts.cleanUrl,
      opts.dest,
    ],
    { auth: opts.auth },
  );
  await scrubWorkspaceGitCredentials(opts.dest);
  await assertSafeGitDir(opts.dest);
}

export async function gitFetch(workspace: string, cleanUrl: string, ref: string, auth?: GitHttpAuth): Promise<void> {
  assertValidBranchName(ref);
  if (!isCleanHttpUrl(cleanUrl)) throw new UnsafeGitRepoError('fetch URL must be http(s) without credentials');
  await runGit(
    ['fetch', '--no-tags', '--no-recurse-submodules', '--', cleanUrl, `+refs/heads/${ref}:refs/remotes/origin/${ref}`],
    { cwd: workspace, auth },
  );
}

/** Current branch name, or null on detached HEAD. */
export async function gitCurrentBranch(workspace: string): Promise<string | null> {
  try {
    const r = await runGit(['symbolic-ref', '--quiet', '--short', 'HEAD'], { cwd: workspace });
    const b = r.stdout.trim();
    return b.length > 0 ? b : null;
  } catch (err) {
    if (err instanceof UnsafeGitRepoError) throw err;
    return null;
  }
}

/**
 * Resolve an agent-supplied start point to a fully-qualified ref from
 * an allowlist: `HEAD`, an existing local branch, or an existing
 * `origin/<branch>` remote-tracking ref. Never passes the raw string to
 * git as an argument.
 */
export async function resolveStartPoint(workspace: string, from: string | undefined): Promise<string> {
  if (from === undefined || from === '' || from === 'HEAD') return 'HEAD';
  if (typeof from !== 'string') throw new GitRefError('invalid start point');
  const stripped = from.replace(/^refs\/heads\//, '').replace(/^refs\/remotes\//, '');
  assertValidBranchName(stripped);
  const candidates = stripped.startsWith('origin/')
    ? [`refs/remotes/${stripped}`]
    : [`refs/heads/${stripped}`, `refs/remotes/origin/${stripped}`];
  for (const ref of candidates) {
    try {
      await runGit(['show-ref', '--verify', '--quiet', ref], { cwd: workspace });
      return ref;
    } catch (err) {
      if (err instanceof UnsafeGitRepoError) throw err;
    }
  }
  throw new GitRefError(`unknown start point: ${from}`);
}

export async function gitCreateBranch(workspace: string, name: string, from?: string): Promise<void> {
  assertValidBranchName(name);
  const start = await resolveStartPoint(workspace, from);
  await runGit(['checkout', '--no-track', '-b', name, start], { cwd: workspace });
}

/**
 * Ensure HEAD is on a `mergecrew/…` branch, creating `name` from HEAD
 * when it is not (fresh clone on the default branch, detached HEAD).
 * Returns the branch HEAD ends up on.
 */
export async function gitEnsureRunBranch(workspace: string, name: string): Promise<string> {
  assertValidBranchName(name);
  const cur = await gitCurrentBranch(workspace);
  if (cur && cur.startsWith(RUN_BRANCH_PREFIX)) return cur;
  try {
    await runGit(['show-ref', '--verify', '--quiet', `refs/heads/${name}`], { cwd: workspace });
    await runGit(['checkout', name], { cwd: workspace });
  } catch (err) {
    if (err instanceof UnsafeGitRepoError) throw err;
    await runGit(['checkout', '--no-track', '-b', name], { cwd: workspace });
  }
  return name;
}

/**
 * `git add -A` then list what is actually staged relative to HEAD. This
 * is the ground truth for commit gating — not the paths an agent claims.
 */
export async function gitStageAllAndList(workspace: string): Promise<string[]> {
  await runGit(['add', '-A'], { cwd: workspace });
  return gitListStaged(workspace);
}

export async function gitListStaged(workspace: string): Promise<string[]> {
  const r = await runGit(
    ['diff', '--cached', '--name-only', '-z', '--no-renames', '--no-ext-diff', '--no-textconv'],
    { cwd: workspace },
  );
  return r.stdout.split('\0').filter((p) => p.length > 0);
}

export interface SafeCommitOpts {
  message: string;
  authorName: string;
  authorEmail: string;
  signoff?: boolean;
  /**
   * Called with the staged paths after `git add -A` and before the
   * commit is created. Throw to refuse the commit (staged state is
   * reset). Only the index the guard saw is committed.
   */
  guardStagedPaths?: (paths: string[]) => void | Promise<void>;
}

export async function gitCommitAll(workspace: string, opts: SafeCommitOpts): Promise<string> {
  const staged = await gitStageAllAndList(workspace);
  if (opts.guardStagedPaths) {
    try {
      await opts.guardStagedPaths(staged);
    } catch (err) {
      await runGit(['reset', '-q'], { cwd: workspace }).catch(() => {});
      throw err;
    }
  }
  const args = ['commit', '--no-verify', '--no-gpg-sign', '--no-edit', '-m', opts.message];
  if (opts.signoff) args.push('--signoff');
  await runGit(args, {
    cwd: workspace,
    env: {
      GIT_AUTHOR_NAME: opts.authorName,
      GIT_AUTHOR_EMAIL: opts.authorEmail,
      GIT_COMMITTER_NAME: opts.authorName,
      GIT_COMMITTER_EMAIL: opts.authorEmail,
    },
  });
  const r = await runGit(['rev-parse', 'HEAD'], { cwd: workspace });
  return r.stdout.trim();
}

export interface SafePushOpts {
  /** Branches that must never be pushed (base / default / release). */
  protectedBranches?: readonly string[];
  /**
   * Skip the `mergecrew/` prefix requirement. Only for supervisor flows
   * whose branch names are generated in code, never by an agent.
   */
  allowAnyBranchPrefix?: boolean;
}

/**
 * Push `refs/heads/<branch>` to the same name on the remote URL built
 * in-process (never `origin` from `.git/config`), with hooks disabled.
 */
export async function gitPush(
  workspace: string,
  cleanUrl: string,
  branch: string,
  auth: GitHttpAuth | undefined,
  opts: SafePushOpts = {},
): Promise<void> {
  if (opts.allowAnyBranchPrefix) {
    assertValidBranchName(branch);
    const prot = new Set((opts.protectedBranches ?? []).map((b) => b.toLowerCase()));
    if (prot.has(branch.toLowerCase())) throw new GitRefError(`refusing to push protected branch: ${branch}`);
  } else {
    assertPushableBranch(branch, opts.protectedBranches);
  }
  if (!isCleanHttpUrl(cleanUrl)) throw new UnsafeGitRepoError('push URL must be http(s) without credentials');
  await runGit(
    ['push', '--no-verify', '--porcelain', '--', cleanUrl, `refs/heads/${branch}:refs/heads/${branch}`],
    { cwd: workspace, auth },
  );
}

/**
 * Clone `baseBranch` into `dir`, revert `mergeSha` (first-parent) on a
 * new `branch`, and push it. Used by the adapters' revert-PR flow.
 */
export async function gitRevertToBranch(opts: {
  dir: string;
  cleanUrl: string;
  auth: GitHttpAuth | undefined;
  baseBranch: string;
  branch: string;
  mergeSha: string;
}): Promise<void> {
  if (!/^[0-9a-f]{7,64}$/i.test(opts.mergeSha)) throw new GitRefError('invalid merge sha');
  await gitClone({ cleanUrl: opts.cleanUrl, ref: opts.baseBranch, dest: opts.dir, auth: opts.auth });
  await gitCreateBranch(opts.dir, opts.branch);
  await runGit(['revert', '--no-edit', '-m', '1', '--end-of-options', opts.mergeSha], {
    cwd: opts.dir,
    env: {
      GIT_AUTHOR_NAME: 'Mergecrew Bot',
      GIT_AUTHOR_EMAIL: 'bot@mergecrew.dev',
      GIT_COMMITTER_NAME: 'Mergecrew Bot',
      GIT_COMMITTER_EMAIL: 'bot@mergecrew.dev',
    },
  });
  await gitPush(opts.dir, opts.cleanUrl, opts.branch, opts.auth, { protectedBranches: [opts.baseBranch] });
}

export interface NumstatEntry {
  path: string;
  additions: number;
  deletions: number;
}

/**
 * `git diff --numstat <base>...<head>` with external diff / textconv
 * disabled. `base` / `head` are validated ref names (no option
 * injection) and passed after `--end-of-options`.
 */
export async function gitDiffNumstat(workspace: string, base: string, head: string): Promise<NumstatEntry[]> {
  const baseName = base.replace(/^origin\//, '');
  assertValidBranchName(baseName);
  assertValidBranchName(head);
  const r = await runGit(
    [
      'diff',
      '--numstat',
      '-z',
      '--no-renames',
      '--no-ext-diff',
      '--no-textconv',
      '--end-of-options',
      `refs/remotes/origin/${baseName}...refs/heads/${head}`,
      '--',
    ],
    { cwd: workspace },
  );
  // -z numstat: "<add>\t<del>\t<path>\0" per file (no renames).
  const out: NumstatEntry[] = [];
  for (const rec of r.stdout.split('\0')) {
    if (!rec) continue;
    const m = /^(\d+|-)\t(\d+|-)\t([\s\S]+)$/.exec(rec);
    if (!m) continue;
    out.push({
      path: m[3]!,
      additions: m[1] === '-' ? 0 : Number(m[1]),
      deletions: m[2] === '-' ? 0 : Number(m[2]),
    });
  }
  return out;
}

/** Added lines of `<base>...<head>` (for outbound secret scanning before push). */
export async function gitAddedLines(workspace: string, base: string, head: string): Promise<string> {
  const baseName = base.replace(/^origin\//, '');
  assertValidBranchName(baseName);
  assertValidBranchName(head);
  const r = await runGit(
    [
      'diff',
      '-U0',
      '--no-color',
      '--no-renames',
      '--no-ext-diff',
      '--no-textconv',
      '--end-of-options',
      `refs/remotes/origin/${baseName}...refs/heads/${head}`,
      '--',
    ],
    { cwd: workspace, maxBuffer: 256 * 1024 * 1024 },
  );
  return r.stdout
    .split('\n')
    .filter((l) => l.startsWith('+') && !l.startsWith('+++'))
    .map((l) => l.slice(1))
    .join('\n');
}
