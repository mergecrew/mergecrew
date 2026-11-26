import { Injectable } from '@nestjs/common';
import { NotFoundError, ValidationError } from '@mergecrew/domain';
import { PrismaService } from '../../common/prisma.service.js';
import { TenantContextService } from '../../common/tenant-context.service.js';

interface CreateInput {
  filePath: string;
  lineRange?: { startLine: number; endLine: number };
  body: string;
  parentId?: string;
}

interface UpdateInput {
  body?: string;
  resolved?: boolean;
}

const USER_SELECT = { id: true, name: true, email: true, avatarUrl: true } as const;

@Injectable()
export class ChangesetCommentService {
  constructor(
    private prisma: PrismaService,
    private tenant: TenantContextService,
  ) {}

  /**
   * Every comment operation first proves the changeset belongs to the
   * tenant org AND the URL's project. Comment lookups then carry the
   * org + changeset predicates explicitly instead of relying on RLS.
   */
  private async requireChangeset(projectSlug: string, csId: string) {
    const t = this.tenant.require();
    const cs = await this.prisma.withTenant(t.organizationId, (tx) =>
      tx.changeset.findFirst({
        where: {
          id: csId,
          organizationId: t.organizationId,
          project: { slug: projectSlug, organizationId: t.organizationId, deletedAt: null },
        },
        select: { id: true },
      }),
    );
    if (!cs) throw new NotFoundError();
    return { t, cs };
  }

  async list(projectSlug: string, csId: string) {
    const { t, cs } = await this.requireChangeset(projectSlug, csId);
    return this.prisma.withTenant(t.organizationId, (tx) =>
      tx.changesetComment.findMany({
        where: { changesetId: cs.id, organizationId: t.organizationId },
        orderBy: { createdAt: 'asc' },
        include: { user: { select: USER_SELECT } },
      }),
    );
  }

  async create(projectSlug: string, csId: string, input: CreateInput) {
    if (!input.body || input.body.trim().length === 0) {
      throw new ValidationError('comment body is required');
    }
    if (!input.filePath) throw new ValidationError('filePath is required');
    if (input.lineRange) {
      const { startLine, endLine } = input.lineRange;
      if (!Number.isInteger(startLine) || !Number.isInteger(endLine)) {
        throw new ValidationError('lineRange must be integers');
      }
      if (startLine < 1 || endLine < startLine) {
        throw new ValidationError('lineRange must have 1 ≤ startLine ≤ endLine');
      }
    }

    const { t, cs } = await this.requireChangeset(projectSlug, csId);

    if (input.parentId) {
      const parent = await this.prisma.withTenant(t.organizationId, (tx) =>
        tx.changesetComment.findFirst({
          where: { id: input.parentId, changesetId: cs.id, organizationId: t.organizationId },
        }),
      );
      if (!parent) throw new ValidationError('parent comment not found on this changeset');
    }

    return this.prisma.withTenant(t.organizationId, (tx) =>
      tx.changesetComment.create({
        data: {
          organizationId: t.organizationId,
          changesetId: cs.id,
          userId: t.userId,
          filePath: input.filePath,
          ...(input.lineRange ? { lineRange: input.lineRange } : {}),
          body: input.body.trim(),
          parentId: input.parentId ?? null,
        },
        include: { user: { select: USER_SELECT } },
      }),
    );
  }

  async update(projectSlug: string, csId: string, commentId: string, input: UpdateInput) {
    const { t, cs } = await this.requireChangeset(projectSlug, csId);
    const existing = await this.prisma.withTenant(t.organizationId, (tx) =>
      tx.changesetComment.findFirst({
        where: { id: commentId, changesetId: cs.id, organizationId: t.organizationId },
      }),
    );
    if (!existing) throw new NotFoundError();

    const data: Record<string, unknown> = {};
    if (input.body !== undefined) {
      // Only the author can edit the body.
      if (existing.userId !== t.userId) {
        throw new ValidationError('only the author can edit the body');
      }
      if (input.body.trim().length === 0) throw new ValidationError('body cannot be empty');
      data.body = input.body.trim();
    }
    if (input.resolved !== undefined) {
      data.resolvedAt = input.resolved ? new Date() : null;
    }

    return this.prisma.withTenant(t.organizationId, (tx) =>
      tx.changesetComment.update({
        where: { id: existing.id, organizationId: t.organizationId },
        data,
        include: { user: { select: USER_SELECT } },
      }),
    );
  }

  async delete(projectSlug: string, csId: string, commentId: string): Promise<void> {
    const { t, cs } = await this.requireChangeset(projectSlug, csId);
    const existing = await this.prisma.withTenant(t.organizationId, (tx) =>
      tx.changesetComment.findFirst({
        where: { id: commentId, changesetId: cs.id, organizationId: t.organizationId },
      }),
    );
    if (!existing) throw new NotFoundError();
    if (existing.userId !== t.userId) {
      throw new ValidationError('only the author can delete a comment');
    }
    await this.prisma.withTenant(t.organizationId, (tx) =>
      tx.changesetComment.delete({ where: { id: existing.id, organizationId: t.organizationId } }),
    );
  }
}
