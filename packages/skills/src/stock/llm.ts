import type { AnySkill } from '../types.js';

/**
 * Reasoning-helper skills. These wrap LLM calls so agents can produce
 * sub-artifacts (specs, summaries, release notes) without needing to think
 * about provider routing themselves.
 *
 * The `llm` handle is injected via `ctx.config.llm` and is expected to look
 * like `{ chat: async (req) => ChatResponse }` — a thin closure created by the
 * runner around the resolved provider.
 */

interface LlmHandle {
  chat: (req: { messages: any[]; maxTokens?: number; temperature?: number }) => Promise<{
    text: string;
    usage: { totalTokens: number };
  }>;
}

function getLlm(ctx: any): LlmHandle | null {
  return (ctx.config?.llm ?? null) as LlmHandle | null;
}

const llmSummarize: AnySkill = {
  name: 'llm.summarize',
  description: 'Summarize a large input into N bullet points.',
  inputSchema: {
    type: 'object',
    properties: { input: { type: 'string' }, bullets: { type: 'integer' } },
    required: ['input'],
    additionalProperties: false,
  },
  sideEffectClass: 'read',
  capabilities: ['llm.chat'],
  async execute(input: any, ctx) {
    const llm = getLlm(ctx);
    if (!llm) return { output: { summary: input.input.slice(0, 800) }, brief: 'no llm; truncated' };
    const r = await llm.chat({
      messages: [
        { role: 'system', content: [{ type: 'text', text: 'Summarize concisely as bullet points.' }] },
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: `Summarize the following in ${input.bullets ?? 5} bullets.\n\n${input.input}`,
            },
          ],
        },
      ],
      maxTokens: 800,
    });
    return { output: { summary: r.text, tokens: r.usage.totalTokens }, brief: 'summarized' };
  },
};

const llmDraftSpec: AnySkill = {
  name: 'llm.draft_spec',
  description: 'Draft a one-paragraph product spec from a fuzzy intent.',
  inputSchema: {
    type: 'object',
    properties: { intent: { type: 'string' }, context: { type: 'string' } },
    required: ['intent'],
    additionalProperties: false,
  },
  sideEffectClass: 'read',
  capabilities: ['llm.chat'],
  async execute(input: any, ctx) {
    const llm = getLlm(ctx);
    if (!llm)
      return { output: { spec: input.intent }, brief: 'no llm; passthrough' };
    const r = await llm.chat({
      messages: [
        {
          role: 'system',
          content: [
            {
              type: 'text',
              text:
                'You are a product manager. Translate the intent into a single paragraph: what & why, ' +
                'success criteria, scope boundary. Be concrete. Keep it under 120 words.',
            },
          ],
        },
        {
          role: 'user',
          content: [
            { type: 'text', text: `Intent: ${input.intent}\n\nContext: ${input.context ?? '(none)'}` },
          ],
        },
      ],
      maxTokens: 600,
    });
    return { output: { spec: r.text, tokens: r.usage.totalTokens }, brief: 'spec drafted' };
  },
};

const llmDraftReleaseNotes: AnySkill = {
  name: 'llm.draft_release_notes',
  description: 'Draft user-facing release notes from a list of changesets.',
  inputSchema: {
    type: 'object',
    properties: { items: { type: 'array', items: { type: 'object' } } },
    required: ['items'],
    additionalProperties: false,
  },
  sideEffectClass: 'read',
  capabilities: ['llm.chat'],
  async execute(input: any, ctx) {
    const llm = getLlm(ctx);
    if (!llm) {
      const text = (input.items ?? []).map((i: any) => `- ${i.title}`).join('\n');
      return { output: { notes: text }, brief: 'no llm; passthrough' };
    }
    const r = await llm.chat({
      messages: [
        {
          role: 'system',
          content: [
            {
              type: 'text',
              text:
                'You write release notes for an end-user audience. Keep them short, plain, ' +
                'and sorted by impact. No marketing fluff. Markdown bullet list.',
            },
          ],
        },
        {
          role: 'user',
          content: [
            { type: 'text', text: `Changesets:\n${JSON.stringify(input.items, null, 2)}` },
          ],
        },
      ],
      maxTokens: 800,
    });
    return { output: { notes: r.text, tokens: r.usage.totalTokens }, brief: 'notes drafted' };
  },
};

export const llmSkills: AnySkill[] = [llmSummarize, llmDraftSpec, llmDraftReleaseNotes];
