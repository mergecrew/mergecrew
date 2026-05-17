import { Injectable } from '@nestjs/common';
import { NotFoundError, ValidationError } from '@mergecrew/domain';
import { effectiveBaseBranch, type PromotionStrategy } from '@mergecrew/db';
import { PrismaService } from '../../common/prisma.service.js';
import { TenantContextService } from '../../common/tenant-context.service.js';

export type PromotionStrategyKind =
  | 'auto_deploy'
  | 'manual_workflow'
  | 'tag_driven'
  | 'deferred';

export interface PromotionStrategyInput {
  kind: PromotionStrategyKind;
  releaseBranch?: string | null;
  workflowFilename?: string | null;
  envInputKey?: string | null;
  envInputValue?: string | null;
  tagPattern?: string | null;
  prodUrl?: string | null;
}

const VALID_KINDS = new Set<PromotionStrategyKind>([
  'auto_deploy',
  'manual_workflow',
  'tag_driven',
  'deferred',
]);

/**
 * Promotion strategy per project (#470). The cherry-pick engine (#471)
 * reads this to decide *what triggers prod from the release ref*:
 *
 *   - `auto_deploy`     — push the release branch; user's CI fires on push.
 *   - `manual_workflow` — push + dispatch a `workflow_dispatch` in the repo.
 *   - `tag_driven`      — tag the release HEAD; user's CI fires on tag.
 *   - `deferred`        — wizard completes without committing to a shape.
 *
 * Per-kind validation is enforced here rather than in the schema so the
 * picker UX can evolve without a migration each time.
 */
@Injectable()
export class PromotionStrategyService {
  constructor(
    private prisma: PrismaService,
    private tenant: TenantContextService,
  ) {}

  async get(projectSlug: string): Promise<PromotionStrategy | null> {
    const t = this.tenant.require();
    const project = await this.prisma.withTenant(t.organizationId, (tx) =>
      tx.project.findFirst({
        where: { slug: projectSlug, organizationId: t.organizationId, deletedAt: null },
        include: { promotionStrategy: true },
      }),
    );
    if (!project) throw new NotFoundError();
    return project.promotionStrategy;
  }

  async upsert(projectSlug: string, input: PromotionStrategyInput): Promise<PromotionStrategy> {
    if (!VALID_KINDS.has(input.kind)) {
      throw new ValidationError(`unknown promotion strategy kind: ${input.kind}`);
    }
    const normalized = this.normalize(input);
    this.validateForKind(normalized);

    const t = this.tenant.require();
    const project = await this.prisma.withTenant(t.organizationId, (tx) =>
      tx.project.findFirst({
        where: { slug: projectSlug, organizationId: t.organizationId, deletedAt: null },
        include: { connectedRepo: true },
      }),
    );
    if (!project) throw new NotFoundError();

    // Default releaseBranch to the connected repo's effective base
    // branch (#469) when the picker leaves it blank. Trunk-based teams
    // get `main`; branch-per-env teams get their `basePrBranch`.
    if (
      normalized.kind !== 'tag_driven' &&
      normalized.kind !== 'deferred' &&
      !normalized.releaseBranch &&
      project.connectedRepo
    ) {
      normalized.releaseBranch = effectiveBaseBranch(project.connectedRepo);
    }

    return this.prisma.withTenant(t.organizationId, (tx) =>
      tx.promotionStrategy.upsert({
        where: { projectId: project.id },
        update: {
          kind: normalized.kind,
          releaseBranch: normalized.releaseBranch,
          workflowFilename: normalized.workflowFilename,
          envInputKey: normalized.envInputKey,
          envInputValue: normalized.envInputValue,
          tagPattern: normalized.tagPattern,
          prodUrl: normalized.prodUrl,
        },
        create: {
          organizationId: project.organizationId,
          projectId: project.id,
          kind: normalized.kind,
          releaseBranch: normalized.releaseBranch,
          workflowFilename: normalized.workflowFilename,
          envInputKey: normalized.envInputKey,
          envInputValue: normalized.envInputValue,
          tagPattern: normalized.tagPattern,
          prodUrl: normalized.prodUrl,
        },
      }),
    );
  }

  private normalize(input: PromotionStrategyInput): PromotionStrategyInput {
    const blankToNull = (v: string | null | undefined): string | null =>
      v != null && v.trim() ? v.trim() : null;
    return {
      kind: input.kind,
      releaseBranch: blankToNull(input.releaseBranch),
      workflowFilename: blankToNull(input.workflowFilename),
      envInputKey: blankToNull(input.envInputKey),
      envInputValue: blankToNull(input.envInputValue),
      tagPattern: blankToNull(input.tagPattern),
      prodUrl: blankToNull(input.prodUrl),
    };
  }

  private validateForKind(s: PromotionStrategyInput): void {
    if (s.kind === 'deferred') return;
    if (s.kind === 'auto_deploy') {
      if (!s.prodUrl) throw new ValidationError('auto_deploy requires prodUrl');
    }
    if (s.kind === 'manual_workflow') {
      if (!s.prodUrl) throw new ValidationError('manual_workflow requires prodUrl');
      if (!s.workflowFilename) {
        throw new ValidationError('manual_workflow requires workflowFilename');
      }
    }
    if (s.kind === 'tag_driven') {
      if (!s.prodUrl) throw new ValidationError('tag_driven requires prodUrl');
      if (!s.tagPattern) throw new ValidationError('tag_driven requires tagPattern');
    }
  }
}
