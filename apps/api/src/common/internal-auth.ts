import { UnauthorizedException } from '@nestjs/common';

/**
 * Server-internal bearer auth (V2.ag / ADR-0009 step 2). The
 * supervisor uses this when calling the sandbox-ops mediator
 * endpoints — agents authenticate via `resolveAgent` instead.
 *
 * The shared secret comes from `MERGECREW_INTERNAL_TOKEN`. If unset,
 * the server rejects every internal call so a misconfigured deploy
 * fails closed instead of accepting unauthenticated supervisor
 * dispatches. The supervisor (`apps/runner`) reads the same env and
 * sends it as `Authorization: Bearer <token>`.
 *
 * Constant-time compare to defeat timing leaks.
 */
import { timingSafeEqual } from 'node:crypto';

export function requireInternalBearer(authHeader: string | undefined): void {
  const expected = (process.env.MERGECREW_INTERNAL_TOKEN ?? '').trim();
  if (!expected) {
    throw new UnauthorizedException({
      code: 'INTERNAL_TOKEN_UNCONFIGURED',
      message:
        'MERGECREW_INTERNAL_TOKEN is unset on the API; supervisor → API dispatch is disabled',
    });
  }
  const presented = authHeader?.startsWith('Bearer ')
    ? authHeader.slice('Bearer '.length).trim()
    : '';
  if (!presented) throw new UnauthorizedException({ code: 'UNAUTHORIZED' });
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new UnauthorizedException({ code: 'UNAUTHORIZED' });
  }
}
