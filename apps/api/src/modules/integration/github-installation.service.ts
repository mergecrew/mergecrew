import { ConflictException, Injectable, Logger } from '@nestjs/common';
import { ForbiddenError } from '@mergecrew/domain';
import { isInstallationBoundToOrg } from '@mergecrew/db';
import { PrismaService } from '../../common/prisma.service.js';
import { verifyInstallGrant, type InstallGrantClaims } from './github-install-tokens.js';

/**
 * Org ↔ GitHub App installation bindings (`org_github_installations`).
 *
 * Bindings are written only by {@link confirmGrant}, i.e. after the
 * install callback verified with GitHub that the installing user can
 * access the installation, and after the same Mergecrew user redeemed
 * the resulting grant with their own session for the same org.
 */
@Injectable()
export class GitHubInstallationService {
  private readonly logger = new Logger(GitHubInstallationService.name);

  constructor(private prisma: PrismaService) {}

  async isBound(organizationId: string, installationId: string): Promise<boolean> {
    return this.prisma.withTenant(organizationId, (tx) =>
      isInstallationBoundToOrg(tx, organizationId, installationId),
    );
  }

  /** Throws a 403 unless `installationId` is bound to `organizationId`. */
  async assertBound(organizationId: string, installationId: string): Promise<void> {
    if (!(await this.isBound(organizationId, installationId))) {
      throw new ForbiddenError('GitHub App installation is not connected to this organization', {
        reason: 'INSTALLATION_NOT_BOUND',
      });
    }
  }

  /**
   * Redeem an install grant for the calling user + org and persist the
   * binding. Re-installs / "configure" round-trips for an installation
   * the org already owns just refresh `accountLogin`.
   */
  async confirmGrant(
    grantToken: string,
    caller: { userId: string; organizationId: string },
  ): Promise<InstallGrantClaims> {
    const grant = verifyInstallGrant(grantToken);
    if (!grant) throw new ForbiddenError('invalid or expired GitHub installation grant');
    if (grant.userId !== caller.userId || grant.orgId !== caller.organizationId) {
      throw new ForbiddenError('GitHub installation grant was issued to a different user or organization');
    }
    await this.bind({
      organizationId: grant.orgId,
      installationId: grant.installationId,
      accountLogin: grant.accountLogin,
      createdByUserId: grant.userId,
    });
    return grant;
  }

  async bind(input: {
    organizationId: string;
    installationId: string;
    accountLogin: string | null;
    createdByUserId: string;
  }): Promise<void> {
    // Cross-tenant uniqueness check: RLS would hide another org's row.
    const existing = await this.prisma.withSystem((db) =>
      db.orgGithubInstallation.findUnique({ where: { installationId: input.installationId } }),
    );
    if (existing && existing.organizationId !== input.organizationId) {
      throw new ConflictException({
        code: 'INSTALLATION_BOUND_TO_OTHER_ORG',
        message: 'This GitHub App installation is already connected to another organization',
      });
    }
    try {
      await this.prisma.withTenant(input.organizationId, (tx) =>
        tx.orgGithubInstallation.upsert({
          where: { installationId: input.installationId },
          update: { accountLogin: input.accountLogin ?? existing?.accountLogin ?? null },
          create: {
            organizationId: input.organizationId,
            installationId: input.installationId,
            accountLogin: input.accountLogin,
            createdByUserId: input.createdByUserId,
          },
        }),
      );
    } catch (err) {
      // Lost a race with another org binding the same id (unique
      // violation surfaces because RLS hides the other row from upsert).
      if ((err as { code?: string })?.code === 'P2002') {
        throw new ConflictException({
          code: 'INSTALLATION_BOUND_TO_OTHER_ORG',
          message: 'This GitHub App installation is already connected to another organization',
        });
      }
      throw err;
    }
  }

  /**
   * Mirror GitHub `installation` webhook lifecycle events. Called only
   * after the webhook signature verified.
   */
  async handleInstallationEvent(action: string | undefined, installationId: string | undefined): Promise<void> {
    if (!installationId || !/^\d+$/.test(installationId)) return;
    if (action === 'deleted') {
      const r = await this.prisma.withSystem((db) =>
        db.orgGithubInstallation.deleteMany({ where: { installationId } }),
      );
      this.logger.log(`installation ${installationId} deleted on GitHub; removed ${r.count} binding(s)`);
    } else if (action === 'suspend') {
      await this.prisma.withSystem((db) =>
        db.orgGithubInstallation.updateMany({
          where: { installationId },
          data: { suspendedAt: new Date() },
        }),
      );
    } else if (action === 'unsuspend') {
      await this.prisma.withSystem((db) =>
        db.orgGithubInstallation.updateMany({
          where: { installationId },
          data: { suspendedAt: null },
        }),
      );
    }
  }
}
