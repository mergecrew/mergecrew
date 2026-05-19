import { ValidationError } from '@mergecrew/domain';
import type { AnySkill, SkillDefinition, SkillExecutionContext, SkillResult } from './types.js';
import {
  HIGH_IMPACT_SKILLS,
  SkillNotAuthorizedError,
  type PolicyEngine,
} from './policy-engine.js';

export interface SkillExecutorOpts {
  /**
   * Optional policy engine for the per-agent allowlist + signed
   * call-tokens for high-impact skills (#581). When absent, both
   * gates are bypassed (V0 / test contexts). Production code wires
   * this with the HMAC engine built from SKILL_SIGNING_KEY.
   */
  policy?: PolicyEngine;
}

export class SkillExecutor {
  private skills = new Map<string, AnySkill>();
  private readonly policy: PolicyEngine | undefined;

  constructor(opts: SkillExecutorOpts = {}) {
    this.policy = opts.policy;
  }

  register(skill: AnySkill): void {
    this.skills.set(skill.name, skill);
  }

  registerAll(skills: AnySkill[]): void {
    for (const s of skills) this.register(s);
  }

  has(name: string): boolean {
    return this.skills.has(name);
  }

  get(name: string): AnySkill | undefined {
    return this.skills.get(name);
  }

  list(): AnySkill[] {
    return Array.from(this.skills.values());
  }

  /**
   * Execute a tool call by name. Validates input shape (lightly), enforces a
   * default timeout, and traps any thrown error into a structured result.
   */
  async execute<I = unknown, O = unknown>(
    name: string,
    input: I,
    ctx: SkillExecutionContext,
  ): Promise<SkillResult<O>> {
    const skill = this.skills.get(name) as SkillDefinition<I, O> | undefined;
    if (!skill) {
      throw new ValidationError(`unknown skill: ${name}`);
    }

    // Per-agent-kind allowlist gate (#581 / #554 T-5). Skip when no
    // allowlist is set so old single-agent callers keep working.
    if (this.policy && ctx.allowedSkills !== undefined) {
      if (!this.policy.isAllowed(name, ctx.allowedSkills)) {
        throw new SkillNotAuthorizedError(
          `agent kind "${ctx.agentKind ?? 'unknown'}" is not allowed to call skill "${name}"`,
          { agentKind: ctx.agentKind, skill: name, code: 'not_authorized' },
        );
      }
    }

    // High-impact skill signature gate (#581). Skip when no policy
    // engine is configured (V0). When configured, every high-impact
    // skill must arrive with a verifiable call-token minted by the
    // runner — the LLM cannot mint one because it has no path to the
    // signing key.
    if (this.policy && HIGH_IMPACT_SKILLS.has(name)) {
      const stepId = ctx.agentStepId;
      if (!ctx.callToken || !stepId) {
        throw new SkillNotAuthorizedError(
          `high-impact skill "${name}" requires a signed call-token`,
          { skill: name, code: 'call_token_missing' },
        );
      }
      if (!this.policy.verifyCallToken(ctx.callToken, { stepId, skill: name })) {
        throw new SkillNotAuthorizedError(
          `high-impact skill "${name}" call-token verification failed`,
          { skill: name, code: 'call_token_invalid' },
        );
      }
    }

    const timeoutMs = skill.timeoutMs ?? 60_000;
    const timeoutController = new AbortController();
    const timer = setTimeout(() => timeoutController.abort(), timeoutMs);

    // Compose abort signals — caller's abort + our timeout.
    const composed = anySignal([ctx.abortSignal, timeoutController.signal]);

    const childCtx: SkillExecutionContext = { ...ctx, abortSignal: composed };

    try {
      const result = await skill.execute(input, childCtx);
      return result;
    } finally {
      clearTimeout(timer);
    }
  }
}

function anySignal(signals: AbortSignal[]): AbortSignal {
  const c = new AbortController();
  for (const s of signals) {
    if (s.aborted) {
      c.abort(s.reason);
      break;
    }
    s.addEventListener('abort', () => c.abort(s.reason), { once: true });
  }
  return c.signal;
}
