import type { GateReason } from '@mergecrew/domain';

/**
 * Lightweight glob match — supports `*`, `**`, and `?`. Sufficient for
 * path-pattern policy enforcement; we don't need brace expansion or
 * extglobs in V1.
 */
function minimatch(input: string, pattern: string, _opts?: { dot?: boolean }): boolean {
  const re = globToRegExp(pattern);
  return re.test(input);
}

function globToRegExp(glob: string): RegExp {
  let re = '^';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === '*') {
      if (glob[i + 1] === '*') {
        re += '.*';
        i++;
        if (glob[i + 1] === '/') i++;
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
}

export interface PolicyDecision {
  ok: boolean;
  reason?: GateReason;
  detail?: string;
  hard?: boolean; // hard means: cannot be approved away.
}

const SENSITIVE_HEURISTICS: { reason: GateReason; matchers: string[] }[] = [
  { reason: 'auth_path', matchers: ['**/auth/**', '**/sessions/**', '**/passwords/**'] },
  { reason: 'billing_path', matchers: ['**/billing/**', '**/payments/**', '**/invoice/**'] },
  { reason: 'migration', matchers: ['**/migrations/**', '**/prisma/migrations/**'] },
];

export class PolicyEngine {
  constructor(private ctx: PolicyContext) {}

  /**
   * Inspect a tool call's intent (skill name + args) and return a policy
   * decision. The runner uses the decision to either continue, raise a gate,
   * or hard-reject.
   */
  check(skillName: string, input: unknown): PolicyDecision {
    const written = pathsFromInput(skillName, input);
    if (written.length === 0) return { ok: true };

    for (const p of written) {
      // Hard blocks first.
      for (const pat of this.ctx.projectHardBlocked) {
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
    return typeof i.path === 'string' ? [i.path] : [];
  }
  if (skillName === 'repo.read_file' || skillName === 'repo.list_paths' || skillName === 'repo.search') {
    return [];
  }
  if (skillName === 'repo.git.commit') {
    return Array.isArray(i.paths) ? i.paths.filter((p: any) => typeof p === 'string') : [];
  }
  return [];
}
