import { Injectable, type ExecutionContext } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';

/**
 * Rate-limit policy.
 *
 * `AppThrottlerGuard` is bound globally (APP_GUARD in app.module.ts) with the
 * module-level default (600 requests / minute / client IP). Auth-sensitive
 * routes override it with the stricter limits below via `@Throttle(...)`.
 *
 * The tracker is `req.ip`; main.ts sets `trust proxy` to one hop so behind
 * Caddy that is the real client address, and the web BFF forwards the
 * browser's address (`X-Forwarded-For`) on its server-side API calls.
 *
 * The storage is the throttler's in-memory store, i.e. per API process.
 * Per-account protections that must hold across processes (magic-link
 * per-email cooldown, MFA attempt lockout) are enforced in the database by
 * the respective services.
 */

const MINUTE = 60_000;

/** Magic-link request: email sending costs money and can be used to spam. */
export const MAGIC_LINK_REQUEST_THROTTLE = { default: { limit: 5, ttl: MINUTE } };
/** Token verification, BFF exchange, and similar one-shot auth calls. */
export const AUTH_STRICT_THROTTLE = { default: { limit: 10, ttl: MINUTE } };
/** TOTP / recovery-code checks: the 11th attempt in a minute is refused. */
export const MFA_CODE_THROTTLE = { default: { limit: 10, ttl: MINUTE } };

/** Paths that must never be throttled per-IP (machine callers, probes). */
const SKIP_PREFIXES = [
  '/healthz',
  '/readyz',
  '/metrics',
  // Third-party webhooks arrive from a handful of provider IPs.
  '/v1/webhooks/',
  // Self-hosted runner agents poll / stream from a single host each.
  '/v1/runner-agent',
];

export function isThrottleExemptPath(path: string): boolean {
  const p = path.toLowerCase();
  return SKIP_PREFIXES.some((prefix) => p === prefix.replace(/\/$/, '') || p.startsWith(prefix));
}

@Injectable()
export class AppThrottlerGuard extends ThrottlerGuard {
  protected override async shouldSkip(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;
    const req = context.switchToHttp().getRequest<{ path?: string; url?: string }>();
    const path = req?.path ?? req?.url ?? '';
    if (isThrottleExemptPath(path)) return true;
    return super.shouldSkip(context);
  }
}
