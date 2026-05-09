import { Inject, Injectable, Scope } from '@nestjs/common';
import { REQUEST } from '@nestjs/core';
import type { Request } from 'express';

export interface TenantContext {
  organizationId: string;
  organizationSlug: string;
  userId: string;
  role: 'owner' | 'admin' | 'operator' | 'viewer';
}

export interface UserContext {
  userId: string;
  /** Tenant present only when the URL is org-scoped (`/v1/orgs/:slug/...`). */
  tenant?: TenantContext;
  /**
   * Last successful MFA challenge timestamp from the JWT's `mfa_at` claim.
   * Undefined when the session was minted without an MFA step. RoleGuard's
   * MFA gate (#107) requires this within a 15-minute window for admin/owner
   * routes when the user is enrolled.
   */
  mfaChallengedAt?: Date;
}

/**
 * Per-request tenant context. The TenantMiddleware stamps the request object
 * with a `mergecrewUser` field; this service reads it back. Request-scoped so
 * each injection point sees the calling request, with no AsyncLocalStorage
 * gymnastics around NestJS's async dispatch.
 */
@Injectable({ scope: Scope.REQUEST })
export class TenantContextService {
  constructor(@Inject(REQUEST) private readonly req: Request) {}

  user(): UserContext | undefined {
    return (this.req as any).mergecrewUser;
  }

  current(): TenantContext | undefined {
    return this.user()?.tenant;
  }

  require(): TenantContext {
    const c = this.current();
    if (!c) throw new Error('TenantContext required but not set');
    return c;
  }

  requireUser(): UserContext {
    const c = this.user();
    if (!c) throw new Error('UserContext required but not set');
    return c;
  }
}

/** Helper for the middleware to stamp the request. */
export function stampUserContextOnRequest(req: Request, ctx: UserContext): void {
  (req as any).mergecrewUser = ctx;
}
