import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Logger,
  Post,
  Query,
  Redirect,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { IsString, MaxLength } from 'class-validator';
import { roleAtLeast } from '@mergecrew/domain';
import { TenantContextService } from '../../common/tenant-context.service.js';
import { PrismaService } from '../../common/prisma.service.js';
import { RequireRole, RoleGuard } from '../../common/role.guard.js';
import {
  signInstallGrant,
  signInstallState,
  verifyInstallState,
  type InstallFrom,
  type InstallStateClaims,
} from './github-install-tokens.js';
import {
  buildAuthorizeUrl,
  exchangeCodeForUserToken,
  findUserInstallation,
  githubOAuthConfigFromEnv,
  type FetchLike,
} from './github-install-verifier.js';
import { GitHubInstallationService } from './github-installation.service.js';

/**
 * GitHub App install round-trip (V1.1, #7; hardened to bind
 * installations to orgs).
 *
 *   1. GET /v1/integrations/github/install?org=<slug>&project=<slug>&from=wizard|settings
 *      Authenticated. The caller must be an operator+ member of `org`.
 *      Mints a signed `state` {userId, orgId, orgSlug, projectSlug, from}
 *      and redirects to GitHub's installation page.
 *
 *   2. GET /v1/integrations/github/install/callback?installation_id=N&state=…[&code=…]
 *      Public (GitHub redirects the browser here). `installation_id` is
 *      attacker-controllable, so it is never trusted on its own:
 *        - without `code`: pin the installation id into a fresh state and
 *          send the user through the App's OAuth authorize step;
 *        - with `code` (OAuth return, or "Request user authorization
 *          during installation" enabled): exchange it for a user token and
 *          require the installation to be listed in GET /user/installations.
 *      On success, mint a short-lived grant and send the browser to the
 *      web tier's `/orgs/<slug>/github-install/complete` route.
 *
 *   3. POST /v1/orgs/:slug/github/installations/confirm {grant}
 *      Called by that web route with the user's own session. Verifies the
 *      grant belongs to the calling user + org and writes the binding.
 */
@Controller('v1/integrations/github')
export class GitHubAppController {
  private readonly logger = new Logger(GitHubAppController.name);
  /** Overridable in tests. */
  fetchImpl: FetchLike = fetch as unknown as FetchLike;

  constructor(
    private tenant: TenantContextService,
    private prisma: PrismaService,
  ) {}

  @Get('install')
  @UseGuards(RoleGuard)
  @Redirect()
  async install(
    @Query('org') org?: string,
    @Query('project') project?: string,
    @Query('from') from?: string,
  ) {
    const u = this.tenant.user();
    if (!u) throw new UnauthorizedException();
    if (!org) throw new UnauthorizedException('missing org');
    const orgRow = await this.prisma.withSystem((db) =>
      db.organization.findFirst({ where: { slug: org, deletedAt: null }, select: { id: true, slug: true } }),
    );
    const membership = orgRow
      ? await this.prisma.withSystem((db) =>
          db.membership.findFirst({
            where: { organizationId: orgRow.id, userId: u.userId },
            select: { role: true },
          }),
        )
      : null;
    if (!orgRow || !membership || !roleAtLeast(membership.role, 'operator')) {
      throw new ForbiddenException('not allowed to install the GitHub App for this organization');
    }
    const slug = process.env.GITHUB_APP_SLUG ?? 'mergecrew';
    const state = signInstallState({
      userId: u.userId,
      orgId: orgRow.id,
      orgSlug: orgRow.slug,
      projectSlug: project ?? '',
      from: from === 'wizard' ? 'wizard' : 'settings',
    });
    return {
      url: `https://github.com/apps/${encodeURIComponent(slug)}/installations/new?state=${encodeURIComponent(state)}`,
      statusCode: 302,
    };
  }

  @Get('install/callback')
  @Redirect()
  async callback(
    @Query('installation_id') queryInstallationId?: string,
    @Query('state') state?: string,
    @Query('setup_action') setupAction?: string,
    @Query('code') code?: string,
  ) {
    const webBase = process.env.WEB_BASE_URL ?? 'http://localhost:3000';
    if (!state) {
      return { url: `${webBase}/?github_install_error=bad_callback`, statusCode: 302 };
    }
    const claims = verifyInstallState(state);
    if (!claims) {
      return { url: `${webBase}/?github_install_error=bad_state`, statusCode: 302 };
    }
    // Once pinned in the signed state, the installation id can't change.
    if (claims.installationId && queryInstallationId && queryInstallationId !== claims.installationId) {
      return errorRedirect(webBase, claims, 'bad_callback');
    }
    const installationId = claims.installationId ?? queryInstallationId;
    if (!installationId || !/^\d+$/.test(installationId)) {
      return errorRedirect(webBase, claims, 'bad_callback');
    }
    const oauth = githubOAuthConfigFromEnv();
    if (!oauth) {
      this.logger.warn('GitHub App install callback: GITHUB_APP_CLIENT_ID/SECRET not set; cannot verify installation');
      return errorRedirect(webBase, claims, 'oauth_not_configured');
    }
    const pinned: InstallStateClaims = {
      ...claims,
      installationId,
      setupAction: claims.setupAction ?? setupAction,
    };

    if (!code) {
      // Prove the browser's GitHub user can access this installation.
      return { url: buildAuthorizeUrl(oauth, signInstallState(pinned)), statusCode: 302 };
    }

    let found: { installationId: string; accountLogin: string | null } | null;
    try {
      const userToken = await exchangeCodeForUserToken(oauth, code, this.fetchImpl);
      found = await findUserInstallation(oauth, userToken, installationId, this.fetchImpl);
    } catch (err) {
      this.logger.warn(`GitHub App install verification failed: ${(err as Error).message}`);
      return errorRedirect(webBase, claims, 'github_verify_failed');
    }
    if (!found) {
      return errorRedirect(webBase, claims, 'installation_not_accessible');
    }
    const grant = signInstallGrant({
      userId: claims.userId,
      orgId: claims.orgId,
      orgSlug: claims.orgSlug,
      projectSlug: claims.projectSlug,
      from: claims.from,
      installationId,
      accountLogin: found.accountLogin,
      setupAction: pinned.setupAction,
    });
    return {
      url: `${webBase}/orgs/${encodeURIComponent(claims.orgSlug)}/github-install/complete?grant=${encodeURIComponent(grant)}`,
      statusCode: 302,
    };
  }
}

class ConfirmInstallationDto {
  @IsString()
  @MaxLength(4096)
  grant!: string;
}

@Controller('v1/orgs/:slug/github/installations')
export class GitHubInstallationController {
  constructor(
    private tenant: TenantContextService,
    private installations: GitHubInstallationService,
  ) {}

  @Post('confirm')
  @RequireRole('operator')
  async confirm(@Body() body: ConfirmInstallationDto) {
    const t = this.tenant.require();
    const grant = await this.installations.confirmGrant(body.grant, {
      userId: t.userId,
      organizationId: t.organizationId,
    });
    return {
      installationId: grant.installationId,
      accountLogin: grant.accountLogin,
      projectSlug: grant.projectSlug,
      from: grant.from,
      setupAction: grant.setupAction ?? null,
    };
  }
}

function errorRedirect(
  webBase: string,
  claims: { orgSlug: string; projectSlug: string; from: InstallFrom },
  code: string,
) {
  const org = encodeURIComponent(claims.orgSlug);
  let path: string;
  if (claims.from === 'wizard') path = `/orgs/${org}/onboarding`;
  else if (claims.projectSlug) path = `/orgs/${org}/projects/${encodeURIComponent(claims.projectSlug)}/settings`;
  else path = `/orgs/${org}`;
  return { url: `${webBase}${path}?github_install_error=${encodeURIComponent(code)}`, statusCode: 302 };
}
