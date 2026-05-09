import { withTenant } from '@mergecrew/db';
import { ValidationError } from '@mergecrew/domain';
import type { AnySkill } from '../types.js';

const changesetResolveComment: AnySkill = {
  name: 'changeset.resolve_comment',
  description:
    'Mark a reviewer comment thread as resolved. Use this after addressing the feedback so the next reviewer pass has an accurate open-comment list.',
  inputSchema: {
    type: 'object',
    properties: {
      commentId: {
        type: 'string',
        description: 'Comment id (root or reply) to mark resolved.',
      },
    },
    required: ['commentId'],
    additionalProperties: false,
  },
  sideEffectClass: 'write_external',
  capabilities: ['changeset.write'],
  timeoutMs: 10_000,
  async execute(input: any, ctx) {
    const commentId = String(input?.commentId ?? '');
    if (!commentId) throw new ValidationError('changeset.resolve_comment: commentId required');
    const updated = await withTenant(ctx.organizationId, async (tx) => {
      const existing = await tx.changesetComment.findFirst({
        where: { id: commentId, organizationId: ctx.organizationId },
      });
      if (!existing) throw new ValidationError(`comment ${commentId} not found`);
      if (existing.resolvedAt) {
        return { id: existing.id, alreadyResolved: true };
      }
      await tx.changesetComment.update({
        where: { id: commentId },
        data: { resolvedAt: new Date() },
      });
      return { id: existing.id, alreadyResolved: false };
    });
    return {
      output: updated,
      brief: updated.alreadyResolved ? `comment ${commentId} already resolved` : `resolved comment ${commentId}`,
    };
  },
};

export const changesetSkills: AnySkill[] = [changesetResolveComment];
