import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { promises as fs, mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { Logger } from 'pino';
import { readWorkspaceFile } from '@mergecrew/skills';

const defaultExecFileAsync = promisify(execFile);

/** Seam for tests — production uses promisified `node:child_process` execFile. */
export type ExecFileAsync = (
  cmd: string,
  args: string[],
  opts?: { timeout?: number; maxBuffer?: number; env?: NodeJS.ProcessEnv },
) => Promise<{ stdout: string; stderr: string }>;

/**
 * `.devcontainer/devcontainer.json` resolution (#570).
 *
 * SECURITY: building a tenant devcontainer runs the tenant's Dockerfile
 * on the supervisor host's Docker daemon (with network access during
 * `RUN` steps). That is NOT safe on a host shared between tenants or
 * with the control plane, so the feature is OFF unless the operator
 * sets `MERGECREW_ENABLE_DEVCONTAINER_BUILD=1` — only do that on a
 * dedicated, single-tenant runner host.
 *
 * When enabled:
 *   - the CLI is the `@devcontainers/cli` version pinned in the runner's
 *     package.json / lockfile, run with `node` directly (no `npx -y`);
 *   - configs that reach outside a plain image build are rejected:
 *     `runArgs`, `mounts`, `privileged`, `capAdd`, `securityOpt`,
 *     `workspaceMount`, `initializeCommand`, `dockerComposeFile`,
 *     `build.options`, network settings, and any `build.context` /
 *     `dockerfile` outside the workspace;
 *   - the image tag is keyed by organization id + a hash of the full
 *     build context, so two orgs never share a cached image;
 *   - the CLI runs with a minimal env (no supervisor secrets).
 */

const DEVCONTAINER_PATH = path.join('.devcontainer', 'devcontainer.json');
const DEVCONTAINER_BUILD_TIMEOUT_MS = 15 * 60 * 1000;
const MAX_CONTEXT_FILES = 50_000;
const MAX_CONTEXT_BYTES = 1024 * 1024 * 1024;

export const DEVCONTAINER_ENABLE_ENV = 'MERGECREW_ENABLE_DEVCONTAINER_BUILD';

export interface MaybeBuildDevcontainerArgs {
  workspacePath: string;
  /** Owning org — part of the image cache key. */
  organizationId: string;
  logger: Logger;
  /** Override the docker binary; defaults to `docker`. */
  dockerBin?: string;
  /** Override the pinned CLI entrypoint (tests). */
  cliPath?: string;
  /** Inject a fake execFile for tests. */
  execFileAsync?: ExecFileAsync;
  /** Defaults to process.env; tests pass the opt-in flag explicitly. */
  env?: NodeJS.ProcessEnv;
}

export type DevcontainerBuildOutcome =
  | { kind: 'disabled' }
  | { kind: 'no_devcontainer' }
  | { kind: 'rejected'; reason: string }
  | { kind: 'cached'; image: string }
  | { kind: 'built'; image: string; durationMs: number }
  | { kind: 'failed'; reason: string };

/** Resolve the pinned `@devcontainers/cli` entrypoint from node_modules. */
export function resolvePinnedDevcontainerCli(): string | null {
  try {
    // Runner compiles to CommonJS; resolve relative to this module so the
    // runner's own (lockfile-pinned) node_modules copy is used.
    const req = createRequire(typeof __filename === 'string' ? __filename : path.join(process.cwd(), 'package.json'));
    const pkgPath = req.resolve('@devcontainers/cli/package.json');
    const pkg = req(pkgPath) as { bin?: string | Record<string, string> };
    const bin = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.devcontainer;
    return bin ? path.join(path.dirname(pkgPath), bin) : null;
  } catch {
    return null;
  }
}

/** Strip `//` + `/* *\/` comments and trailing commas (devcontainer.json is JSONC). */
export function parseJsonc(text: string): unknown {
  let out = '';
  let inStr = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    const n = text[i + 1];
    if (inStr) {
      out += c;
      if (c === '\\') {
        out += n ?? '';
        i++;
      } else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') {
      inStr = true;
      out += c;
    } else if (c === '/' && n === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
    } else if (c === '/' && n === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i++;
    } else {
      out += c;
    }
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
}

const FORBIDDEN_TOP_LEVEL = [
  'runArgs',
  'mounts',
  'privileged',
  'capAdd',
  'securityOpt',
  'workspaceMount',
  'initializeCommand',
  'dockerComposeFile',
  'network',
  'networkMode',
];

/**
 * Validate a parsed devcontainer config. Returns the absolute build
 * context directory (null for image-only configs) or throws with the
 * rejection reason.
 */
export function validateDevcontainerConfig(
  cfg: unknown,
  workspaceReal: string,
  configDir: string,
): { contextDir: string | null } {
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) throw new Error('devcontainer.json must be an object');
  const c = cfg as Record<string, unknown>;
  for (const k of FORBIDDEN_TOP_LEVEL) {
    if (k in c) throw new Error(`devcontainer.json: "${k}" is not allowed`);
  }
  const build = (c.build ?? null) as Record<string, unknown> | null;
  if (build !== null && (typeof build !== 'object' || Array.isArray(build))) {
    throw new Error('devcontainer.json: "build" must be an object');
  }
  if (build && ('options' in build || 'network' in build)) {
    throw new Error('devcontainer.json: "build.options" / "build.network" are not allowed');
  }
  const dockerfile = (build?.dockerfile ?? build?.dockerFile ?? c.dockerFile ?? c.dockerfile) as unknown;
  const context = (build?.context ?? c.context) as unknown;
  if (dockerfile === undefined && context === undefined) return { contextDir: null };
  if (dockerfile !== undefined && typeof dockerfile !== 'string') throw new Error('devcontainer.json: dockerfile must be a string');
  if (context !== undefined && typeof context !== 'string') throw new Error('devcontainer.json: context must be a string');
  const inside = (p: string) => {
    const rel = path.relative(workspaceReal, p);
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  };
  const ctxDir = path.resolve(configDir, (context as string | undefined) ?? '.');
  if (path.isAbsolute((context as string | undefined) ?? '.') || !inside(ctxDir)) {
    throw new Error('devcontainer.json: build context must stay inside the workspace');
  }
  if (typeof dockerfile === 'string') {
    const df = path.resolve(configDir, dockerfile);
    if (path.isAbsolute(dockerfile) || !inside(df)) {
      throw new Error('devcontainer.json: dockerfile must stay inside the workspace');
    }
  }
  return { contextDir: ctxDir };
}

/**
 * Deterministic hash of a build context: every entry's relative path,
 * type, mode and content (symlinks by target string; never followed).
 */
export async function hashBuildContext(dir: string): Promise<string> {
  const h = createHash('sha256');
  let files = 0;
  let bytes = 0;
  async function walk(cur: string): Promise<void> {
    const entries = await fs.readdir(cur, { withFileTypes: true });
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of entries) {
      if (e.name === '.git') continue;
      const full = path.join(cur, e.name);
      const rel = path.relative(dir, full);
      if (++files > MAX_CONTEXT_FILES) throw new Error('build context has too many files');
      if (e.isSymbolicLink()) {
        h.update(`L\0${rel}\0${await fs.readlink(full)}\0`);
      } else if (e.isDirectory()) {
        h.update(`D\0${rel}\0`);
        await walk(full);
      } else if (e.isFile()) {
        const st = await fs.lstat(full);
        bytes += st.size;
        if (bytes > MAX_CONTEXT_BYTES) throw new Error('build context too large');
        h.update(`F\0${rel}\0${st.mode & 0o777}\0${st.size}\0`);
        h.update(await fs.readFile(full));
      }
    }
  }
  await walk(dir);
  return h.digest('hex');
}

export function devcontainerImageTag(organizationId: string, contextHash: string): string {
  const org = createHash('sha256').update(organizationId).digest('hex').slice(0, 12);
  return `mergecrew-devcontainer:${org}-${contextHash.slice(0, 24)}`;
}

function minimalEnv(src: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const home = mkdtempSync(path.join(os.tmpdir(), 'mergecrew-devcontainer-home-'));
  const env: NodeJS.ProcessEnv = { PATH: src.PATH ?? '/usr/local/bin:/usr/bin:/bin', HOME: home };
  for (const k of ['DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_CERT_PATH', 'DOCKER_TLS_VERIFY', 'LANG']) {
    if (src[k]) env[k] = src[k];
  }
  return env;
}

export async function maybeBuildDevcontainer(
  args: MaybeBuildDevcontainerArgs,
): Promise<DevcontainerBuildOutcome> {
  const { workspacePath, organizationId, logger } = args;
  const env = args.env ?? process.env;
  if (env[DEVCONTAINER_ENABLE_ENV] !== '1') return { kind: 'disabled' };

  const dockerBin = args.dockerBin ?? 'docker';
  const execFn: ExecFileAsync = args.execFileAsync ?? defaultExecFileAsync;

  let configBytes: Buffer;
  try {
    // Symlink-safe read: the config must be a regular file in the tree.
    configBytes = await readWorkspaceFile(workspacePath, DEVCONTAINER_PATH, { maxBytes: 1024 * 1024 });
  } catch {
    return { kind: 'no_devcontainer' };
  }

  const workspaceReal = await fs.realpath(workspacePath);
  let contextDir: string | null;
  try {
    const parsed = parseJsonc(configBytes.toString('utf8'));
    ({ contextDir } = validateDevcontainerConfig(parsed, workspaceReal, path.join(workspaceReal, '.devcontainer')));
  } catch (err: any) {
    const reason = String(err?.message ?? err);
    logger.warn({ workspacePath, reason }, 'devcontainer config rejected; falling back to stack image');
    return { kind: 'rejected', reason };
  }

  let ctxHash: string;
  try {
    if (contextDir) {
      // The context must also *resolve* inside the workspace (no
      // symlinked directory pointing elsewhere).
      const realCtx = await fs.realpath(contextDir);
      const rel = path.relative(workspaceReal, realCtx);
      if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('context resolves outside the workspace');
    }
    const ctx = contextDir ? await hashBuildContext(contextDir) : '';
    ctxHash = createHash('sha256').update(configBytes).update('\0').update(ctx).digest('hex');
  } catch (err: any) {
    return { kind: 'rejected', reason: `devcontainer build context: ${String(err?.message ?? err)}` };
  }
  const imageRef = devcontainerImageTag(organizationId, ctxHash);
  const childEnv = minimalEnv(env);

  // Cache hit? Tag is org-scoped, so a hit is always this org's build.
  let cached = false;
  try {
    const probe = await execFn(dockerBin, ['image', 'inspect', '--format', '{{json .Config.Labels}}', imageRef], {
      env: childEnv,
    });
    const labels = JSON.parse(probe.stdout.trim() || 'null') as Record<string, string> | null;
    cached = labels?.['mergecrew.organizationId'] === organizationId;
  } catch {
    /* not cached */
  }
  if (cached) {
    logger.info({ workspacePath, image: imageRef }, 'devcontainer image cached; skipping build');
    return { kind: 'cached', image: imageRef };
  }

  const cli = args.cliPath ?? resolvePinnedDevcontainerCli();
  if (!cli) {
    return { kind: 'failed', reason: 'devcontainer build: pinned @devcontainers/cli is not installed in the runner' };
  }

  const t0 = Date.now();
  try {
    await execFn(
      process.execPath,
      [
        cli,
        'build',
        '--image-name',
        imageRef,
        '--workspace-folder',
        workspaceReal,
        '--config',
        path.join(workspaceReal, DEVCONTAINER_PATH),
        '--label',
        `mergecrew.organizationId=${organizationId}`,
      ],
      { timeout: DEVCONTAINER_BUILD_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024, env: childEnv },
    );
  } catch (err: any) {
    const reason =
      err?.code === 'ENOENT'
        ? 'devcontainer build: node / docker not on PATH on the supervisor host'
        : `devcontainer build failed: ${String(err?.stderr ?? err?.message ?? err).slice(0, 1000)}`;
    logger.warn({ workspacePath, reason }, 'devcontainer build failed; falling back to stack image');
    return { kind: 'failed', reason };
  }

  const durationMs = Date.now() - t0;
  logger.info({ workspacePath, image: imageRef, durationMs }, 'devcontainer image built');
  return { kind: 'built', image: imageRef, durationMs };
}
