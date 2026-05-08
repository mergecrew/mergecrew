import { ValidationError } from '@mergecrew/domain';
import type { AnySkill } from '../types.js';

const slackPost: AnySkill = {
  name: 'slack.post',
  description: 'Post a message to a Slack channel.',
  inputSchema: {
    type: 'object',
    properties: {
      channel: { type: 'string' },
      text: { type: 'string' },
      blocks: { type: 'array' },
    },
    required: ['channel', 'text'],
    additionalProperties: false,
  },
  sideEffectClass: 'write_external',
  capabilities: ['comms.write', 'net.outbound'],
  timeoutMs: 30_000,
  async execute(input: any, ctx) {
    if (!ctx.adapters.comms) throw new ValidationError('slack.post: comms adapter required');
    await ctx.adapters.comms.postSlack(input.channel, input.text, input.blocks);
    return { output: { ok: true }, brief: `slack ${input.channel}` };
  },
};

const emailSend: AnySkill = {
  name: 'email.send_to_org_owner',
  description: 'Send an email to the organization owner.',
  inputSchema: {
    type: 'object',
    properties: { subject: { type: 'string' }, html: { type: 'string' } },
    required: ['subject', 'html'],
    additionalProperties: false,
  },
  sideEffectClass: 'write_external',
  capabilities: ['comms.write', 'net.outbound'],
  timeoutMs: 30_000,
  async execute(input: any, ctx) {
    if (!ctx.adapters.comms) throw new ValidationError('email.send_to_org_owner: comms adapter required');
    await ctx.adapters.comms.sendOrgOwnerEmail(ctx.organizationId, input.subject, input.html);
    return { output: { ok: true }, brief: `email "${input.subject}"` };
  },
};

export const commsSkills: AnySkill[] = [slackPost, emailSend];
