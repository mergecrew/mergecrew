import { Controller, Get, Query, Redirect, UnauthorizedException, UseGuards } from '@nestjs/common';
import crypto from 'node:crypto';
import { TenantContextService } from '../../common/tenant-context.service.js';
import { RoleGuard } from '../../common/role.guard.js';

/**
 * GitHub App install entrypoint + callback (V1.1, #7).
 *
 * Two endpoints make a round-trip:
 *
 *   1. GET /v1/integrations/github/install?org=<slug>&project=<slug>&from=wizard|settings
 *      The BFF's "Install GitHub App" button links here. The user is
 *      already authenticated (Nest session cookie); we mint an HMAC-signed
 *      `state` blob containing {userId, orgSlug, projectSlug, from, exp} and
 *      redirect to GitHub's installation page with it.
 *
 *   2. GET /v1/integrations/github/install/callback?installation_id=N&state=<signed>
 *      GitHub redirects back here after the user completes the install.
 *      We verify the state HMAC + expiry, then redirect to the originating
 *      surface (wizard or settings) with `installation_id` in the query so
 *      the repo-connect form can pre-fill and the user only needs to pick
 *      the repo.
 *
 * State is HMAC-SHA256 over `version|userId|orgSlug|projectSlug|from|exp`
 * keyed with `JWT_SECRET`. We don't trust the redirect URL fragment for
 * routing; everything that drives the BFF redirect comes from the verified
 * state.
 *
 * `STATE_VERSION` bumped to `v2` for the wizard-aware `from` field (#455).
 * In-flight `v1` tokens fail verification and surface a `bad_state` error;
 * the 15-min TTL bounds the blast radius.
 */
@Controller('v1/integrations/github')
export class GitHubAppController {
  constructor(private tenant: TenantContextService) {}

  @Get('install')
  @UseGuards(RoleGuard)
  @Redirect()
  install(
    @Query('org') org?: string,
    @Query('project') project?: string,
    @Query('from') from?: string,
  ) {
    const u = this.tenant.user();
    if (!u) throw new UnauthorizedException();
    if (!org) throw new UnauthorizedException('missing org');
    const slug = process.env.GITHUB_APP_SLUG ?? 'mergecrew';
    const state = signState({
      userId: u.userId,
      orgSlug: org,
      projectSlug: project ?? '',
      from: from === 'wizard' ? 'wizard' : 'settings',
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
    const { orgSlug, projectSlug, from } = verified;
    const installQuery = `installation_id=${encodeURIComponent(installationId)}&from=github_install&setup_action=${encodeURIComponent(setupAction ?? '')}`;
    let target: string;
    if (from === 'wizard') {
      // Wizard owns the FTE; route the user back to the active step
      // (Connect a repo) instead of bouncing them through Settings.
      target = `${webBase}/orgs/${orgSlug}/onboarding?${installQuery}`;
    } else if (projectSlug) {
      target = `${webBase}/orgs/${orgSlug}/projects/${projectSlug}/settings?${installQuery}`;
    } else {
      target = `${webBase}/orgs/${orgSlug}?installation_id=${encodeURIComponent(installationId)}&from=github_install`;
    }
    return { url: target, statusCode: 302 };
  }
}

const STATE_VERSION = 'v2';
const STATE_TTL_MS = 15 * 60 * 1000; // 15 minutes

type InstallFrom = 'wizard' | 'settings';

interface StateClaims {
  userId: string;
  orgSlug: string;
  projectSlug: string;
  from: InstallFrom;
}

function signState(claims: StateClaims): string {
  const exp = Date.now() + STATE_TTL_MS;
  const payload = `${STATE_VERSION}|${claims.userId}|${claims.orgSlug}|${claims.projectSlug}|${claims.from}|${exp}`;
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
  if (parts.length !== 7) return null;
  const [version, userId, orgSlug, projectSlug, fromStr, expStr, sig] = parts as [
    string, string, string, string, string, string, string,
  ];
  if (version !== STATE_VERSION) return null;
  if (fromStr !== 'wizard' && fromStr !== 'settings') return null;
  const exp = Number(expStr);
  if (!Number.isFinite(exp) || exp < Date.now()) return null;
  const expected = crypto
    .createHmac('sha256', process.env.JWT_SECRET ?? 'dev-secret')
    .update(`${version}|${userId}|${orgSlug}|${projectSlug}|${fromStr}|${exp}`)
    .digest('base64url');
  // timing-safe compare
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return null;
  if (!crypto.timingSafeEqual(a, b)) return null;
  return { userId, orgSlug, projectSlug, from: fromStr as InstallFrom };
}
