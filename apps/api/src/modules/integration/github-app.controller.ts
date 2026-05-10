import { Controller, Get, Query, Redirect, UnauthorizedException, UseGuards } from '@nestjs/common';
import crypto from 'node:crypto';
import { TenantContextService } from '../../common/tenant-context.service.js';
import { RoleGuard } from '../../common/role.guard.js';

/**
 * GitHub App install entrypoint + callback (V1.1, #7).
 *
 * Two endpoints make a round-trip:
 *
 *   1. GET /v1/integrations/github/install?org=<slug>&project=<slug>
 *      The BFF's "Install GitHub App" button links here. The user is
 *      already authenticated (Nest session cookie); we mint an HMAC-signed
 *      `state` blob containing {userId, orgSlug, projectSlug, exp} and
 *      redirect to GitHub's installation page with it.
 *
 *   2. GET /v1/integrations/github/install/callback?installation_id=N&state=<signed>
 *      GitHub redirects back here after the user completes the install.
 *      We verify the state HMAC + expiry, then redirect to the BFF's
 *      project settings page with `installation_id` in the query so the
 *      repo-connect form can pre-fill and the user only needs to pick the
 *      repo.
 *
 * State is HMAC-SHA256 over `version|userId|orgSlug|projectSlug|exp` keyed
 * with `JWT_SECRET`. We don't trust the redirect URL fragment for routing;
 * everything that drives the BFF redirect comes from the verified state.
 */
@Controller('v1/integrations/github')
export class GitHubAppController {
  constructor(private tenant: TenantContextService) {}

  @Get('install')
  @UseGuards(RoleGuard)
  @Redirect()
  install(@Query('org') org?: string, @Query('project') project?: string) {
    const u = this.tenant.user();
    if (!u) throw new UnauthorizedException();
    if (!org) throw new UnauthorizedException('missing org');
    const slug = process.env.GITHUB_APP_SLUG ?? 'mergecrew-app';
    const state = signState({
      userId: u.userId,
      orgSlug: org,
      projectSlug: project ?? '',
    });
    return {
      url: `https://github.com/apps/${slug}/installations/new?state=${encodeURIComponent(state)}`,
      statusCode: 302,
    };
  }

  @Get('install/callback')
  @Redirect()
  callback(
    @Query('installation_id') installationId?: string,
    @Query('state') state?: string,
    @Query('setup_action') setupAction?: string,
  ) {
    const webBase = process.env.WEB_BASE_URL ?? 'http://localhost:3000';
    if (!state || !installationId) {
      // Bad callback. Bounce to home with an error toast hint; we don't
      // know which org/project to land on.
      return { url: `${webBase}/?github_install_error=bad_callback`, statusCode: 302 };
    }
    const verified = verifyState(state);
    if (!verified) {
      return { url: `${webBase}/?github_install_error=bad_state`, statusCode: 302 };
    }
    const { orgSlug, projectSlug } = verified;
    const target = projectSlug
      ? `${webBase}/orgs/${orgSlug}/projects/${projectSlug}/settings?installation_id=${encodeURIComponent(installationId)}&from=github_install&setup_action=${encodeURIComponent(setupAction ?? '')}`
      : `${webBase}/orgs/${orgSlug}?installation_id=${encodeURIComponent(installationId)}&from=github_install`;
    return { url: target, statusCode: 302 };
  }
}

const STATE_VERSION = 'v1';
const STATE_TTL_MS = 15 * 60 * 1000; // 15 minutes

interface StateClaims {
  userId: string;
  orgSlug: string;
  projectSlug: string;
}

function signState(claims: StateClaims): string {
  const exp = Date.now() + STATE_TTL_MS;
  const payload = `${STATE_VERSION}|${claims.userId}|${claims.orgSlug}|${claims.projectSlug}|${exp}`;
  const sig = crypto
    .createHmac('sha256', process.env.JWT_SECRET ?? 'dev-secret')
    .update(payload)
    .digest('base64url');
  return Buffer.from(`${payload}|${sig}`, 'utf8').toString('base64url');
}

function verifyState(token: string): StateClaims | null {
  let raw: string;
  try {
    raw = Buffer.from(token, 'base64url').toString('utf8');
  } catch {
    return null;
  }
  const parts = raw.split('|');
  if (parts.length !== 6) return null;
  const [version, userId, orgSlug, projectSlug, expStr, sig] = parts as [
    string, string, string, string, string, string,
  ];
  if (version !== STATE_VERSION) return null;
  const exp = Number(expStr);
  if (!Number.isFinite(exp) || exp < Date.now()) return null;
  const expected = crypto
    .createHmac('sha256', process.env.JWT_SECRET ?? 'dev-secret')
    .update(`${version}|${userId}|${orgSlug}|${projectSlug}|${exp}`)
    .digest('base64url');
  // timing-safe compare
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return null;
  if (!crypto.timingSafeEqual(a, b)) return null;
  return { userId, orgSlug, projectSlug };
}
