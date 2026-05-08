import { ValidationError } from '@mergecrew/domain';
import type { AnySkill } from '../types.js';

const trackerListIssues: AnySkill = {
  name: 'tracker.list_issues',
  description: 'List issues from the configured tracker (Linear or GitHub Issues).',
  inputSchema: {
    type: 'object',
    properties: {
      status: { type: 'string' },
      max: { type: 'integer' },
    },
    additionalProperties: false,
  },
  sideEffectClass: 'read',
  capabilities: ['tracker.read', 'net.outbound'],
  timeoutMs: 30_000,
  async execute(input: any, ctx) {
    if (!ctx.adapters.tracker) throw new ValidationError('tracker.list_issues: tracker adapter required');
    const issues = await ctx.adapters.tracker.listIssues({ status: input.status, max: input.max ?? 50 });
    return { output: { issues }, brief: `${issues.length} issues` };
  },
};

const trackerCreateIssue: AnySkill = {
  name: 'tracker.create_issue',
  description: 'Create an issue in the configured tracker.',
  inputSchema: {
    type: 'object',
    properties: {
      title: { type: 'string' },
      body: { type: 'string' },
      labels: { type: 'array', items: { type: 'string' } },
    },
    required: ['title'],
    additionalProperties: false,
  },
  sideEffectClass: 'write_external',
  capabilities: ['tracker.write', 'net.outbound'],
  timeoutMs: 30_000,
  async execute(input: any, ctx) {
    if (!ctx.adapters.tracker) throw new ValidationError('tracker.create_issue: tracker adapter required');
    const issue = await ctx.adapters.tracker.createIssue({
      title: input.title,
      body: input.body ?? '',
      labels: input.labels,
    });
    return { output: issue, brief: `created ${issue.id}` };
  },
};

const trackerCommentIssue: AnySkill = {
  name: 'tracker.comment_issue',
  description: 'Comment on an issue in the configured tracker.',
  inputSchema: {
    type: 'object',
    properties: { id: { type: 'string' }, body: { type: 'string' } },
    required: ['id', 'body'],
    additionalProperties: false,
  },
  sideEffectClass: 'write_external',
  capabilities: ['tracker.write', 'net.outbound'],
  timeoutMs: 30_000,
  async execute(input: any, ctx) {
    if (!ctx.adapters.tracker) throw new ValidationError('tracker.comment_issue: tracker adapter required');
    await ctx.adapters.tracker.commentIssue(input.id, input.body);
    return { output: { ok: true }, brief: `commented ${input.id}` };
  },
};

export const trackerSkills: AnySkill[] = [trackerListIssues, trackerCreateIssue, trackerCommentIssue];
