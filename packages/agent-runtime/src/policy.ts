import type { GateReason } from '@mergecrew/domain';
import { isGitMetadataPath } from '@mergecrew/skills';

/**
 * Lightweight glob match — supports `*`, `**`, and `?`. Sufficient for
 * path-pattern policy enforcement; we don't need brace expansion or
 * extglobs in V1.
 */
export function minimatch(input: string, pattern: string, _opts?: { dot?: boolean }): boolean {
  const re = globToRegExp(pattern);
  return re.test(input);
}

function globToRegExp(glob: string): RegExp {
  let re = '^';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i++;
        if (glob[i + 1] === '/') {
          // `**/` matches zero or more whole leading segments.
          re += '(?:.*/)?';
          i++;
        } else {
          re += '.*';
        }
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else if ('.+^${}()|[]\\'.includes(c)) {
      re += '\\' + c;
    } else {
      re += c;
    }
  }
  re += '$';
  return new RegExp(re);
}

export interface PolicyContext {
  agentDoNotTouch: string[];
  projectSensitivePatterns: string[];
  projectHardBlocked: string[];
  /**
   * Ground truth for the commit gate: returns the paths that are
   * actually staged for the next commit (the runner wires this to
   * `git add -A && git diff --cached --name-only` under the safe-git
   * wrapper). When set, agent-supplied `paths` on `repo.git.commit` are
   * ignored. Errors fail closed.
   */
  stagedPathsProvider?: () => Promise<string[]>;
  /**
   * Skills an agent may never call from the loop (production promotion
   * is human-only). Defaults to `IRREVERSIBLE_AGENT_SKILLS`.
   */
  irreversibleSkills?: readonly string[];
}

export interface PolicyDecision {
  ok: boolean;
  reason?: GateReason;
  detail?: string;
  hard?: boolean; // hard means: cannot be approved away.
}

/**
 * Changes to these paths alter what runs in CI / deploy pipelines (and
 * therefore what gets the tenant's deploy secrets) or the infra itself.
 * They always need a human, regardless of project config.
 */
export const DEFAULT_SENSITIVE_PATHS: readonly string[] = [
  '.github/workflows/**',
  '.github/actions/**',
  '**/action.yml',
  '**/action.yaml',
  '.gitea/workflows/**',
  '.forgejo/workflows/**',
  '.gitlab-ci.yml',
  '**/.gitlab-ci.yml',
  '.circleci/**',
  '.buildkite/**',
  'Jenkinsfile',
  '**/Jenkinsfile',
  'azure-pipelines.yml',
  'bitbucket-pipelines.yml',
  '.travis.yml',
  '**/Dockerfile',
  '**/Dockerfile.*',
  '**/*.Dockerfile',
  '**/*.dockerfile',
  '**/docker-compose*.yml',
  '**/docker-compose*.yaml',
  '**/compose.yml',
  '**/compose.yaml',
  '.devcontainer/**',
  '**/*.tf',
  '**/*.tfvars',
  '**/*.hcl',
];

/** Never committable / writable by an agent, regardless of approval. */
export const DEFAULT_HARD_BLOCKED: readonly string[] = ['**/.env*'];

/** Skills the agent loop refuses outright. */
export const IRREVERSIBLE_AGENT_SKILLS: readonly string[] = ['deploy.prod'];

const SENSITIVE_HEURISTICS: { reason: GateReason; matchers: readonly string[] }[] = [
  { reason: 'auth_path', matchers: ['**/auth/**', '**/sessions/**', '**/passwords/**'] },
  { reason: 'billing_path', matchers: ['**/billing/**', '**/payments/**', '**/invoice/**'] },
  { reason: 'migration', matchers: ['**/migrations/**', '**/prisma/migrations/**'] },
  { reason: 'sensitive_path', matchers: DEFAULT_SENSITIVE_PATHS },
];

/** True when any path matches a default CI / deploy / infra pattern. */
export function touchesDeploySensitivePaths(paths: readonly string[]): string[] {
  return paths.filter((p) => DEFAULT_SENSITIVE_PATHS.some((pat) => minimatch(p, pat, { dot: true })));
}

export class PolicyEngine {
  constructor(private ctx: PolicyContext) {}

  /**
   * Synchronous decision from the call's declared intent (skill name +
   * args). For `repo.git.commit` prefer `checkCall`, which evaluates the
   * real staged diff.
   */
  check(skillName: string, input: unknown): PolicyDecision {
    const irreversible = this.ctx.irreversibleSkills ?? IRREVERSIBLE_AGENT_SKILLS;
    if (irreversible.includes(skillName)) {
      return {
        ok: false,
        reason: 'production_promote',
        detail: `${skillName} is not callable by agents; production promotion is human-only`,
        hard: true,
      };
    }
    return this.evaluatePaths(pathsFromInput(skillName, input));
  }

  /**
   * Async decision used by the agent loop. For commits, gates on the
   * paths that are actually staged — an agent cannot under-declare.
   */
  async checkCall(skillName: string, input: unknown): Promise<PolicyDecision> {
    const sync = this.check(skillName, input);
    if (!sync.ok) return sync;
    if (skillName === 'repo.git.commit' && this.ctx.stagedPathsProvider) {
      let staged: string[];
      try {
        staged = await this.ctx.stagedPathsProvider();
      } catch (err) {
        return {
          ok: false,
          reason: 'sensitive_path',
          detail: `could not compute the staged diff: ${(err as Error)?.message ?? String(err)}`,
          hard: true,
        };
      }
      return this.evaluatePaths(staged);
    }
    return sync;
  }

  /**
   * Hard-block-only check (no approvable gates) — used inside the
   * commit itself, right before the commit object is written.
   */
  hardBlockedPaths(paths: readonly string[]): string[] {
    const hard = [...DEFAULT_HARD_BLOCKED, ...this.ctx.projectHardBlocked];
    return paths.filter((p) => isGitMetadataPath(p) || hard.some((pat) => minimatch(p, pat, { dot: true })));
  }

  evaluatePaths(written: readonly string[]): PolicyDecision {
    if (written.length === 0) return { ok: true };

    for (const p of written) {
      if (isGitMetadataPath(p)) {
        return { ok: false, reason: 'sensitive_path', detail: `${p} is git metadata`, hard: true };
      }
      // Hard blocks first.
      for (const pat of [...DEFAULT_HARD_BLOCKED, ...this.ctx.projectHardBlocked]) {
        if (minimatch(p, pat, { dot: true })) {
          return { ok: false, reason: 'sensitive_path', detail: `${p} matches hard-block ${pat}`, hard: true };
        }
      }
    }

    for (const p of written) {
      for (const pat of this.ctx.agentDoNotTouch) {
        if (minimatch(p, pat, { dot: true })) {
          return { ok: false, reason: 'sensitive_path', detail: `${p} matches agent do-not-touch ${pat}` };
        }
      }
    }

    for (const p of written) {
      for (const pat of this.ctx.projectSensitivePatterns) {
        if (minimatch(p, pat, { dot: true })) {
          return { ok: false, reason: 'sensitive_path', detail: `${p} matches project sensitive ${pat}` };
        }
      }
    }

    for (const p of written) {
      for (const h of SENSITIVE_HEURISTICS) {
        for (const m of h.matchers) {
          if (minimatch(p, m, { dot: true })) {
            return { ok: false, reason: h.reason, detail: `${p} flagged by heuristic ${m}` };
          }
        }
      }
    }

    return { ok: true };
  }
}

function pathsFromInput(skillName: string, input: unknown): string[] {
  if (!input || typeof input !== 'object') return [];
  const i = input as any;
  if (skillName === 'repo.write_file') {
    return typeof i.path === 'string' ? [normalizeRel(i.path)] : [];
  }
  if (skillName === 'repo.read_file' || skillName === 'repo.list_paths' || skillName === 'repo.search') {
    return [];
  }
  if (skillName === 'repo.git.commit') {
    // Declared paths only matter when no staged-diff provider is wired
    // (`checkCall` replaces them with the real staged set).
    return Array.isArray(i.paths) ? i.paths.filter((p: any) => typeof p === 'string').map(normalizeRel) : [];
  }
  return [];
}

/** `./a//b` → `a/b` so `.github/...` patterns can't be dodged with `./`. */
function normalizeRel(p: string): string {
  return p
    .replace(/\\/g, '/')
    .split('/')
    .filter((s) => s.length > 0 && s !== '.')
    .join('/');
}
