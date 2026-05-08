import { ValidationError } from '@mergecrew/domain';
import type { AnySkill, SkillDefinition, SkillExecutionContext, SkillResult } from './types.js';

export class SkillExecutor {
  private skills = new Map<string, AnySkill>();

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
