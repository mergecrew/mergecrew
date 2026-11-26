import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import type { Request } from 'express';
import { PrismaService } from './prisma.service.js';
import type { UserContext } from './tenant-context.service.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const READ_ONLY_ERROR_CODE = 'demo_project_readonly';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const READ_ONLY_ERROR_MESSAGE =
  'This is a read-only demo project. Set up your own project to trigger real runs.';

/**
 * Blocks mutating requests against demo projects (#438). Pairs with
 * `Project.demo` (#437) and the UI affordances (#439) to keep the demo
 * sandbox safe to click around even if a button accidentally renders.
 *
 * `MERGECREW_DEMO_MODE=1` (local-dev compose) opts out — the seeded
 * demo there is the fully-runnable click-to-try experience and needs
 * to accept POST /runs. Production / signup-flow demos run without
 * the env flag and stay read-only.
 *
 * Registered globally via APP_GUARD so coverage is exhaustive. Global
 * guards run before controller-level guards, so this guard is also the
 * fail-closed backstop for org-scoped routes: any route with a `:slug`
 * param that arrives without a tenant context (i.e. the auth middleware
 * didn't run or didn't resolve a membership) is rejected outright.
 *
 * Demo protection checks both the URL's `:projectSlug` AND the project
 * of the object addressed by well-known id params (`:csId`,
 * `:approvalId`, `:runId`), so a demo-project object can't be mutated
 * by pairing its id with a non-demo slug in the URL.
 *
 * Reads the tenant context directly off the Express request object
 * (#463 — stamped by the middleware in `apps/api/src/main.ts`) instead
 * of injecting `TenantContextService`. NestJS resolves APP_GUARD as a
 * singleton; the request-scoped tenant service can't be injected
 * reliably here without forcing the whole guard to request scope, which
 * would reinstantiate it on every request across the entire app.
 */
@Injectable()
export class DemoProjectGuard implements CanActivate {
  constructor(private prisma: PrismaService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<Request>();
    const params = (req.params as Record<string, string> | undefined) ?? {};
    const tenant = (req as { mergecrewUser?: UserContext }).mergecrewUser?.tenant;

    // Fail closed: every `:slug` route is org-scoped (`/v1/orgs/:slug/...`).
    if (params.slug !== undefined && !tenant) throw new ForbiddenException();

    if (SAFE_METHODS.has(req.method)) return true;
    if (process.env.MERGECREW_DEMO_MODE === '1') return true;
    if (!tenant) return true; // non-org route (e.g. /v1/me, webhooks)

    const orgId = tenant.organizationId;
    const isDemo = await this.prisma.withTenant(orgId, async (tx) => {
      if (params.projectSlug) {
        const project = await tx.project.findFirst({
          where: { organizationId: orgId, slug: params.projectSlug, deletedAt: null },
          select: { demo: true },
        });
        if (project?.demo) return true;
      }
      if (params.csId) {
        const cs = await tx.changeset.findFirst({
          where: { id: params.csId, organizationId: orgId },
          select: { project: { select: { demo: true } } },
        });
        if (cs?.project.demo) return true;
      }
      // uuid-typed columns: skip malformed ids (the service 404s them).
      if (params.approvalId && UUID_RE.test(params.approvalId)) {
        const ar = await tx.approvalRequest.findFirst({
          where: { id: params.approvalId, organizationId: orgId },
          select: { project: { select: { demo: true } } },
        });
        if (ar?.project.demo) return true;
      }
      if (params.runId && UUID_RE.test(params.runId)) {
        const run = await tx.dailyRun.findFirst({
          where: { id: params.runId, organizationId: orgId },
          select: { project: { select: { demo: true } } },
        });
        if (run?.project.demo) return true;
      }
      return false;
    });
    if (isDemo) {
      throw new ForbiddenException({
        error: { code: READ_ONLY_ERROR_CODE, message: READ_ONLY_ERROR_MESSAGE },
      });
    }
    return true;
  }
}
