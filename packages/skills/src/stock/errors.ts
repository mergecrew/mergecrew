import type { AnySkill } from '../types.js';

const errorsListRecent: AnySkill = {
  name: 'errors.list_recent',
  description: 'List recent errors from the configured error tracker (e.g., Sentry).',
  inputSchema: {
    type: 'object',
    properties: {
      sinceMs: { type: 'integer' },
      max: { type: 'integer' },
      environment: { type: 'string' },
    },
    additionalProperties: false,
  },
  sideEffectClass: 'read',
  capabilities: ['net.outbound'],
  timeoutMs: 30_000,
  async execute(input: any, ctx) {
    const cfg = (ctx.config?.sentry ?? {}) as { token?: string; org?: string; project?: string };
    if (!cfg.token || !cfg.org || !cfg.project) {
      return { output: { issues: [] }, brief: 'no sentry config' };
    }
    const since = input.sinceMs ? new Date(Date.now() - input.sinceMs).toISOString() : undefined;
    const url = `https://sentry.io/api/0/projects/${cfg.org}/${cfg.project}/issues/?statsPeriod=24h&limit=${input.max ?? 25}${
      since ? `&start=${encodeURIComponent(since)}` : ''
    }${input.environment ? `&environment=${encodeURIComponent(input.environment)}` : ''}`;
    const r = await fetch(url, {
      headers: { authorization: `Bearer ${cfg.token}` },
      signal: ctx.abortSignal,
    });
    if (!r.ok) return { output: { issues: [], error: `HTTP ${r.status}` }, brief: 'sentry error' };
    const json = (await r.json()) as any[];
    const issues = json.map((i: any) => ({
      id: i.id,
      title: i.title,
      culprit: i.culprit,
      level: i.level,
      count: i.count,
      lastSeen: i.lastSeen,
      shortId: i.shortId,
      permalink: i.permalink,
    }));
    return { output: { issues }, brief: `${issues.length} issues` };
  },
};

export const errorsSkills: AnySkill[] = [errorsListRecent];
