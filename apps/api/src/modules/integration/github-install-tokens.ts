import crypto from 'node:crypto';

/**
 * Signed, short-lived tokens for the GitHub App install round-trip.
 *
 *   - `state`  — minted by `GET /v1/integrations/github/install` for an
 *     authenticated org member; travels through GitHub and back to the
 *     public callback. Carries the Mergecrew user + org so the callback
 *     knows who started the flow. After the first callback hop it is
 *     re-minted with the `installationId` pinned, so the OAuth hop can't
 *     swap installations.
 *   - `grant`  — minted by the callback only after GitHub confirmed (via
 *     a user-to-server token) that the GitHub user can access the
 *     installation. The web tier redeems it with the *same* Mergecrew
 *     user's session (`POST /v1/orgs/:slug/github/installations/confirm`)
 *     before the org↔installation binding is written, so a grant that
 *     ends up in someone else's browser is useless.
 *
 * Format: base64url(JSON payload) + "." + base64url(HMAC-SHA256). The HMAC
 * key is derived from JWT_SECRET with a per-kind label so these tokens
 * can never be confused with each other or with session JWTs.
 */

export type InstallFrom = 'wizard' | 'settings';

export interface InstallStateClaims {
  userId: string;
  orgId: string;
  orgSlug: string;
  projectSlug: string;
  from: InstallFrom;
  /** Pinned after the first callback hop. */
  installationId?: string;
  setupAction?: string;
}

export interface InstallGrantClaims {
  userId: string;
  orgId: string;
  orgSlug: string;
  projectSlug: string;
  from: InstallFrom;
  installationId: string;
  accountLogin: string | null;
  setupAction?: string;
}

type Kind = 'state' | 'grant';

const VERSION: Record<Kind, string> = {
  state: 'gh-install-state-v3',
  grant: 'gh-install-grant-v1',
};

export const STATE_TTL_MS = 15 * 60 * 1000;
export const GRANT_TTL_MS = 10 * 60 * 1000;

function signingKey(kind: Kind): Buffer {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('JWT_SECRET must be set to sign GitHub install tokens');
    }
  }
  return crypto
    .createHmac('sha256', secret || 'dev-secret')
    .update(`mergecrew:github-install:${kind}`)
    .digest();
}

function sign<T extends object>(kind: Kind, claims: T, ttlMs: number, now = Date.now()): string {
  const payload = Buffer.from(
    JSON.stringify({ v: VERSION[kind], ...claims, exp: now + ttlMs }),
    'utf8',
  ).toString('base64url');
  const sig = crypto.createHmac('sha256', signingKey(kind)).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

function verify(kind: Kind, token: string, now = Date.now()): Record<string, unknown> | null {
  if (typeof token !== 'string' || token.length > 4096) return null;
  const dot = token.indexOf('.');
  if (dot <= 0 || dot !== token.lastIndexOf('.')) return null;
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = crypto.createHmac('sha256', signingKey(kind)).update(payload).digest();
  let provided: Buffer;
  try {
    provided = Buffer.from(sig, 'base64url');
  } catch {
    return null;
  }
  if (provided.length !== expected.length || !crypto.timingSafeEqual(provided, expected)) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const obj = parsed as Record<string, unknown>;
  if (obj.v !== VERSION[kind]) return null;
  if (typeof obj.exp !== 'number' || !Number.isFinite(obj.exp) || obj.exp < now) return null;
  return obj;
}

function str(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

function baseClaims(obj: Record<string, unknown>) {
  const userId = str(obj.userId);
  const orgId = str(obj.orgId);
  const orgSlug = str(obj.orgSlug);
  const projectSlug = str(obj.projectSlug);
  const from = obj.from;
  if (!userId || !orgId || !orgSlug || projectSlug === null) return null;
  if (from !== 'wizard' && from !== 'settings') return null;
  return { userId, orgId, orgSlug, projectSlug, from: from as InstallFrom };
}

export function signInstallState(claims: InstallStateClaims, now?: number): string {
  return sign('state', claims, STATE_TTL_MS, now);
}

export function verifyInstallState(token: string, now?: number): InstallStateClaims | null {
  const obj = verify('state', token, now);
  if (!obj) return null;
  const base = baseClaims(obj);
  if (!base) return null;
  const installationId = str(obj.installationId) ?? undefined;
  if (installationId !== undefined && !/^\d+$/.test(installationId)) return null;
  const setupAction = str(obj.setupAction) ?? undefined;
  return { ...base, installationId, setupAction };
}

export function signInstallGrant(claims: InstallGrantClaims, now?: number): string {
  return sign('grant', claims, GRANT_TTL_MS, now);
}

export function verifyInstallGrant(token: string, now?: number): InstallGrantClaims | null {
  const obj = verify('grant', token, now);
  if (!obj) return null;
  const base = baseClaims(obj);
  if (!base) return null;
  const installationId = str(obj.installationId);
  if (!installationId || !/^\d+$/.test(installationId)) return null;
  const accountLogin = str(obj.accountLogin);
  const setupAction = str(obj.setupAction) ?? undefined;
  return { ...base, installationId, accountLogin, setupAction };
}
