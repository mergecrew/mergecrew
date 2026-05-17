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
 * Registered globally via APP_GUARD so coverage is exhaustive — falls
 * through harmlessly when the route isn't project-scoped (no
 * `:projectSlug` param) or when the request method is safe.
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
    if (SAFE_METHODS.has(req.method)) return true;
    if (process.env.MERGECREW_DEMO_MODE === '1') return true;

    const projectSlug = (req.params as Record<string, string> | undefined)?.projectSlug;
    if (!projectSlug) return true;

    const tenant = (req as { mergecrewUser?: UserContext }).mergecrewUser?.tenant;
    if (!tenant) return true; // RoleGuard will reject auth before us if needed.

    const project = await this.prisma.withTenant(tenant.organizationId, (tx) =>
      tx.project.findFirst({
        where: { organizationId: tenant.organizationId, slug: projectSlug, deletedAt: null },
        select: { demo: true },
      }),
    );
    if (project?.demo) {
      throw new ForbiddenException({
        error: { code: READ_ONLY_ERROR_CODE, message: READ_ONLY_ERROR_MESSAGE },
      });
    }
    return true;
  }
}
