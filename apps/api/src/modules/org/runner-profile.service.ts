import { randomUUID } from 'node:crypto';
import { ForbiddenException, Injectable } from '@nestjs/common';
import { ValidationError } from '@mergecrew/domain';
import { CryptoService } from '../../common/crypto.service.js';
import { PrismaService } from '../../common/prisma.service.js';
import { TenantContextService } from '../../common/tenant-context.service.js';
import { isTrustedOrgSlug } from '../../common/trusted-orgs.js';

type ProfileKind =
  | 'none'
  | 'instance_builtin'
  | 'agent'
  | 'fargate_byo'
  | 'github_actions';

export interface UpdateProfileInput {
  kind: ProfileKind;
  awsRoleArn?: string;
  awsRegion?: string;
  fargateCluster?: string;
  fargateTaskDefinition?: string;
  fargateSubnets?: string[];
  fargateSecurityGroups?: string[];
  githubRepoFullName?: string;
  githubWorkflowFileName?: string;
  /** Plaintext PAT — server envelope-encrypts before persisting. */
  githubPat?: string;
}

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
    private readonly crypto: CryptoService,
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
        // Surface only WHETHER a token is stored, never the ciphertext
        // or the plaintext (#772). The UI uses this to decide whether
        // the "rotate PAT" field is required.
        githubTokenConfigured: !!profile?.githubTokenCiphertext,
        agents,
      };
    });
  }

  /**
   * Update the per-org runner profile (V2.af / #767). Admin-only at
   * the controller; this method additionally enforces the trusted-org
   * gate (ADR-0006) and generates a per-org `awsExternalId` on first
   * save for `fargate_byo` (ADR-0007).
   *
   * Audit log entry records both the old and new kind so an operator
   * can trace runner-profile changes alongside their other privileged
   * actions.
   */
  async update(input: UpdateProfileInput) {
    const ctx = this.tenant.require();

    if (input.kind === 'instance_builtin' && !isTrustedOrgSlug(ctx.organizationSlug)) {
      throw new ForbiddenException({
        code: 'NOT_TRUSTED',
        message:
          'this org is not allowed to use the instance-builtin runner; ask the operator to add the slug to MERGECREW_TRUSTED_ORG_SLUGS',
      });
    }

    // For fargate_byo, validate that we have at least the role ARN
    // even if the orchestrator's dispatcher isn't live yet (#769).
    // Keeps half-configured profiles out of the DB.
    if (input.kind === 'fargate_byo' && !input.awsRoleArn) {
      throw new ValidationError(
        'fargate_byo requires awsRoleArn — paste the role you provisioned in your AWS account',
      );
    }

    // For github_actions (#772), validate the repo/workflow are
    // present + the PAT actually has access. The PAT goes out
    // exactly once over HTTPS to GitHub's API; if the validation
    // call succeeds we trust the rest of the dispatch pipeline.
    if (input.kind === 'github_actions') {
      if (!input.githubRepoFullName || !input.githubWorkflowFileName) {
        throw new ValidationError(
          'github_actions requires githubRepoFullName and githubWorkflowFileName',
        );
      }
      // PAT is required on first save of github_actions OR when the
      // caller is explicitly rotating. If unset on update we keep
      // the existing ciphertext.
      const existing = await this.prisma.withTenant(ctx.organizationId, (tx) =>
        tx.runnerProfile.findUnique({
          where: { organizationId: ctx.organizationId },
          select: { githubTokenCiphertext: true },
        }),
      );
      const willHavePat = input.githubPat || existing?.githubTokenCiphertext;
      if (!willHavePat) {
        throw new ValidationError(
          'github_actions requires githubPat on first save — paste a GitHub PAT with repo + workflow scopes',
        );
      }
      if (input.githubPat) {
        await assertGithubRepoAccessible(
          input.githubRepoFullName,
          input.githubPat,
        );
      }
    }

    return this.prisma.withTenant(ctx.organizationId, async (tx) => {
      const existing = await tx.runnerProfile.findUnique({
        where: { organizationId: ctx.organizationId },
        select: { kind: true, awsExternalId: true, githubTokenCiphertext: true },
      });
      const previousKind = existing?.kind ?? 'none';

      // Generate or reuse the per-org external ID — never rotate it on
      // subsequent saves so the operator's trust policy stays valid.
      const nextExternalId =
        input.kind === 'fargate_byo'
          ? existing?.awsExternalId ?? randomUUID()
          : existing?.awsExternalId ?? null;

      // Encrypt the PAT if the caller supplied one this turn;
      // otherwise reuse whatever's already on the row (i.e. PATCHes
      // that don't rotate the token don't have to resend it).
      const nextGithubCiphertext = input.githubPat
        ? this.crypto.encrypt(input.githubPat)
        : existing?.githubTokenCiphertext ?? null;

      const upserted = await tx.runnerProfile.upsert({
        where: { organizationId: ctx.organizationId },
        create: {
          organizationId: ctx.organizationId,
          kind: input.kind,
          awsRoleArn: input.awsRoleArn ?? null,
          awsRegion: input.awsRegion ?? null,
          fargateCluster: input.fargateCluster ?? null,
          fargateTaskDefinition: input.fargateTaskDefinition ?? null,
          fargateSubnets: input.fargateSubnets ?? [],
          fargateSecurityGroups: input.fargateSecurityGroups ?? [],
          awsExternalId: nextExternalId,
          githubRepoFullName: input.githubRepoFullName ?? null,
          githubWorkflowFileName: input.githubWorkflowFileName ?? null,
          githubTokenCiphertext: nextGithubCiphertext,
        },
        update: {
          kind: input.kind,
          awsRoleArn: input.awsRoleArn ?? null,
          awsRegion: input.awsRegion ?? null,
          fargateCluster: input.fargateCluster ?? null,
          fargateTaskDefinition: input.fargateTaskDefinition ?? null,
          ...(input.fargateSubnets !== undefined
            ? { fargateSubnets: input.fargateSubnets }
            : {}),
          ...(input.fargateSecurityGroups !== undefined
            ? { fargateSecurityGroups: input.fargateSecurityGroups }
            : {}),
          awsExternalId: nextExternalId,
          githubRepoFullName: input.githubRepoFullName ?? null,
          githubWorkflowFileName: input.githubWorkflowFileName ?? null,
          githubTokenCiphertext: nextGithubCiphertext,
        },
      });

      await tx.auditLogEntry.create({
        data: {
          organizationId: ctx.organizationId,
          actorUserId: ctx.userId,
          action: 'runnerProfile.updated',
          target: { runnerProfileId: upserted.id },
          metadata: { from: previousKind, to: input.kind },
        },
      });

      return {
        kind: upserted.kind,
        awsRoleArn: upserted.awsRoleArn,
        awsExternalId: upserted.awsExternalId,
        awsRegion: upserted.awsRegion,
        fargateCluster: upserted.fargateCluster,
        fargateTaskDefinition: upserted.fargateTaskDefinition,
        fargateSubnets: upserted.fargateSubnets,
        fargateSecurityGroups: upserted.fargateSecurityGroups,
        githubRepoFullName: upserted.githubRepoFullName,
        githubWorkflowFileName: upserted.githubWorkflowFileName,
        // We never echo the PAT or its ciphertext back. The presence
        // of a stored token is surfaced via a boolean in the GET
        // response (the read endpoint adds it below).
      };
    });
  }
}

/**
 * Calls `GET /repos/{full}` with the user-supplied PAT to verify it
 * has access to the target repo. Surfacing a clear "your PAT can't
 * reach this repo" error at save time beats failing on dispatch.
 */
async function assertGithubRepoAccessible(
  repoFullName: string,
  pat: string,
): Promise<void> {
  const res = await fetch(`https://api.github.com/repos/${repoFullName}`, {
    headers: {
      authorization: `Bearer ${pat}`,
      accept: 'application/vnd.github+json',
      'user-agent': 'mergecrew-api',
    },
  });
  if (res.status === 404) {
    throw new ValidationError(
      `github_actions: repo ${repoFullName} not found or PAT lacks access (verify the PAT has the 'repo' scope)`,
    );
  }
  if (res.status === 401 || res.status === 403) {
    throw new ValidationError(
      `github_actions: PAT rejected by GitHub (${res.status}). Confirm the token has 'repo' + 'workflow' scopes.`,
    );
  }
  if (!res.ok) {
    throw new ValidationError(
      `github_actions: GitHub repo check returned ${res.status} ${res.statusText}`,
    );
  }
}
