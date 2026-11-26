import type { INestApplication } from '@nestjs/common';

/**
 * Path classification for the tenant/auth middleware in `main.ts`.
 *
 * All patterns are case-insensitive so `/V1/orgs/...` or `/v1/ME/...`
 * can't slip past authentication. Express routing is additionally made
 * case-sensitive (see `enableCaseSensitiveRouting`), so such paths 401
 * here and then never reach a controller.
 */
export const ORG_PATH_RE = /^\/v1\/orgs(\/|$)/i;
export const ME_PATH_RE = /^\/v1\/me(\/|$)/i;
export const ORG_SLUG_RE = /^\/v1\/orgs\/([^/]+)/i;
// The GitHub App install entrypoint needs an authenticated user; its
// `/callback` sibling stays public. Optional trailing slash because
// Express' non-strict routing would otherwise route `/install/` too.
const AUTHED_INTEGRATION_RE = /^\/v1\/integrations\/github\/install\/?$/i;

export function isOrgPath(path: string): boolean {
  return ORG_PATH_RE.test(path);
}

export function isMePath(path: string): boolean {
  return ME_PATH_RE.test(path);
}

export function isAuthedIntegrationPath(path: string): boolean {
  return AUTHED_INTEGRATION_RE.test(path);
}

/** True when the tenant/auth middleware must authenticate the request. */
export function requiresAuthentication(path: string): boolean {
  return isOrgPath(path) || isMePath(path) || isAuthedIntegrationPath(path);
}

/**
 * Turn on Express' "case sensitive routing" so `/V1/...` does not match
 * `/v1/...` controllers. Nest's ExpressAdapter instantiates the router in
 * its constructor (before user code runs), so flipping the app setting
 * alone is not enough — the existing router's flag is updated too. Must
 * run before `app.init()`/`app.listen()`, which is when routes register.
 */
export function enableCaseSensitiveRouting(app: INestApplication): void {
  const instance = app.getHttpAdapter().getInstance() as {
    set(name: string, value: unknown): void;
    router?: { caseSensitive?: boolean };
    _router?: { caseSensitive?: boolean };
  };
  instance.set('case sensitive routing', true);
  const router = instance.router ?? instance._router;
  if (router) router.caseSensitive = true;
}
