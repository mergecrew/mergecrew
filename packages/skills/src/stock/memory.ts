import { withTenant } from '@mergecrew/db';
import type { Prisma } from '@mergecrew/db';
import type { AnySkill } from '../types.js';

const memoryStore: AnySkill = {
  name: 'memory.store',
  description: 'Store a piece of project memory in a named collection.',
  inputSchema: {
    type: 'object',
    properties: {
      collection: { type: 'string' },
      content: { type: 'string' },
      metadata: { type: 'object' },
    },
    required: ['collection', 'content'],
    additionalProperties: false,
  },
  sideEffectClass: 'write_workspace',
  capabilities: ['memory.write'],
  async execute(input: any, ctx) {
    await withTenant(ctx.organizationId, async (tx) => {
      await tx.memoryDocument.create({
        data: {
          organizationId: ctx.organizationId,
          projectId: ctx.projectId,
          collection: input.collection,
          content: input.content,
          metadata: (input.metadata ?? {}) as Prisma.InputJsonValue,
        },
      });
    });
    return { output: { ok: true }, brief: `stored in ${input.collection}` };
  },
};

const memoryRecall: AnySkill = {
  name: 'memory.recall',
  description: 'Recall recent project memory entries from a collection.',
  inputSchema: {
    type: 'object',
    properties: { collection: { type: 'string' }, max: { type: 'integer' } },
    required: ['collection'],
    additionalProperties: false,
  },
  sideEffectClass: 'read',
  capabilities: ['memory.read'],
  async execute(input: any, ctx) {
    const rows = await withTenant(ctx.organizationId, async (tx) =>
      tx.memoryDocument.findMany({
        where: { projectId: ctx.projectId, collection: input.collection },
        orderBy: { createdAt: 'desc' },
        take: input.max ?? 20,
      }),
    );
    const entries = rows.map((r) => ({
      id: r.id,
      content: r.content,
      metadata: r.metadata,
      createdAt: r.createdAt.toISOString(),
    }));
    return { output: { entries }, brief: `${entries.length} memories` };
  },
};

export const memorySkills: AnySkill[] = [memoryStore, memoryRecall];
