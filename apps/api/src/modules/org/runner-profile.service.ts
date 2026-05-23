import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../common/prisma.service.js';
import { TenantContextService } from '../../common/tenant-context.service.js';
import { isTrustedOrgSlug } from '../../common/trusted-orgs.js';

/**
 * Read access to the `runner_profile` row + the org's enrolled
 * `runner_agent` rows (ADR-0002 / ADR-0004). Profiles created by the
 * migration backfill exist for every pre-existing org; orgs created
 * after the migration may not have a row yet — that absence is
 * surfaced as `kind: 'none'` so callers don't need to special-case it.
 */
@Injectable()
export class RunnerProfileService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenant: TenantContextService,
  ) {}

  async get() {
    const ctx = this.tenant.require();
    return this.prisma.withTenant(ctx.organizationId, async (tx) => {
      const profile = await tx.runnerProfile.findUnique({
        where: { organizationId: ctx.organizationId },
      });
      const agents = await tx.runnerAgent.findMany({
        where: { organizationId: ctx.organizationId },
        orderBy: [{ revokedAt: 'asc' }, { createdAt: 'desc' }],
        select: {
          id: true,
          name: true,
          prefix: true,
          lastSeenAt: true,
          revokedAt: true,
          agentVersion: true,
          createdAt: true,
        },
      });
      const kind = profile?.kind ?? 'none';
      return {
        kind,
        isTrustedForInstanceBuiltin: isTrustedOrgSlug(ctx.organizationSlug),
        awsRoleArn: profile?.awsRoleArn ?? null,
        awsExternalId: profile?.awsExternalId ?? null,
        awsRegion: profile?.awsRegion ?? null,
        fargateCluster: profile?.fargateCluster ?? null,
        fargateTaskDefinition: profile?.fargateTaskDefinition ?? null,
        fargateSubnets: profile?.fargateSubnets ?? [],
        fargateSecurityGroups: profile?.fargateSecurityGroups ?? [],
        githubRepoFullName: profile?.githubRepoFullName ?? null,
        githubWorkflowFileName: profile?.githubWorkflowFileName ?? null,
        agents,
      };
    });
  }
}
