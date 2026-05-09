import { ValidationError } from '@mergecrew/domain';
import type { AnySkill } from '../types.js';

interface LlmHandle {
  chat: (req: {
    messages: any[];
    maxTokens?: number;
    temperature?: number;
    requireVision?: boolean;
  }) => Promise<{ text: string; usage: { totalTokens: number } }>;
}

function getLlm(ctx: any): LlmHandle | null {
  return (ctx.config?.llm ?? null) as LlmHandle | null;
}

const DEFAULT_CRITERIA = [
  'visible visual regressions vs prior state',
  'broken layout / overlapping elements / clipped content',
  'illegible text (low contrast, tiny font sizes)',
  'inconsistency with the rest of the product (button styles, spacing)',
  'obvious placeholder content that shipped to dev (lorem ipsum, "TODO", broken images)',
];

const SYSTEM_PROMPT = [
  'You are the Design Reviewer agent.',
  'You receive a screenshot of a deployed UI and produce a short list of structured findings.',
  '',
  'Rules:',
  '- Only flag issues you can directly see in the screenshot.',
  '- Severity is one of: critical, major, minor, nit.',
  '- Be concise — one sentence per finding.',
  '- If the screenshot looks healthy, return an empty array.',
  '',
  'Return ONLY valid JSON with shape:',
  '  { "findings": [ { "severity": "...", "area": "...", "finding": "..." } ] }',
  'Do not wrap in markdown. Do not include any prose outside the JSON.',
].join('\n');

interface Finding {
  severity: 'critical' | 'major' | 'minor' | 'nit';
  area: string;
  finding: string;
}

function parseFindings(text: string): Finding[] {
  // Strip a leading ```json fence if the model added one despite instructions.
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  try {
    const parsed = JSON.parse(trimmed) as { findings?: Finding[] };
    if (!parsed?.findings || !Array.isArray(parsed.findings)) return [];
    return parsed.findings.filter(
      (f) => f && typeof f.severity === 'string' && typeof f.finding === 'string',
    );
  } catch {
    return [];
  }
}

const designReviewScreenshot: AnySkill = {
  name: 'design.review_screenshot',
  description:
    'Review a UI screenshot against a list of criteria using the configured vision LLM. Returns structured findings { severity, area, finding }[]. Pass either `dataUrl` (base64-encoded) or `url` (http(s)) — exactly one is required.',
  inputSchema: {
    type: 'object',
    properties: {
      dataUrl: {
        type: 'string',
        description: 'Inline data URL: `data:<mime>;base64,<…>`. Use for screenshots produced by web.screenshot_url.',
      },
      url: {
        type: 'string',
        format: 'uri',
        description: 'Remote http(s) URL the model can fetch directly.',
      },
      criteria: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Optional list of project-specific criteria to weigh in addition to the defaults (regressions, layout, contrast, consistency, placeholder content).',
      },
      mimeType: {
        type: 'string',
        description: 'Override MIME type for raw bytes; defaults inferred from dataUrl.',
      },
    },
    additionalProperties: false,
  },
  sideEffectClass: 'read',
  capabilities: ['llm.chat', 'net.outbound'],
  timeoutMs: 90_000,
  async execute(input: any, ctx) {
    const llm = getLlm(ctx);
    if (!llm) {
      return {
        output: { findings: [] as Finding[], skipped: true, reason: 'no llm configured' },
        brief: 'design review skipped (no llm)',
      };
    }
    const dataUrl = input?.dataUrl as string | undefined;
    const url = input?.url as string | undefined;
    if (!dataUrl && !url) throw new ValidationError('design.review_screenshot: dataUrl or url required');
    if (dataUrl && url) throw new ValidationError('design.review_screenshot: pass exactly one of dataUrl or url');

    const criteria = (Array.isArray(input?.criteria) ? input.criteria : []).concat(DEFAULT_CRITERIA);
    const userText = `Review this screenshot. Criteria, in priority order:\n${criteria
      .map((c: string, i: number) => `${i + 1}. ${c}`)
      .join('\n')}`;

    const r = await llm.chat({
      requireVision: true,
      maxTokens: 1500,
      temperature: 0,
      messages: [
        { role: 'system', content: [{ type: 'text', text: SYSTEM_PROMPT }] },
        {
          role: 'user',
          content: [
            { type: 'text', text: userText },
            {
              type: 'image_url',
              image_url: { url: dataUrl ?? url },
            },
          ],
        },
      ],
    });

    const findings = parseFindings(r.text);
    return {
      output: { findings, raw: r.text, tokens: r.usage.totalTokens },
      brief:
        findings.length === 0
          ? 'design review: no findings'
          : `design review: ${findings.length} finding${findings.length === 1 ? '' : 's'}`,
    };
  },
};

export const designSkills: AnySkill[] = [designReviewScreenshot];
