import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  Logger,
} from '@nestjs/common';
import type { Request } from 'express';
import { PrismaService } from './prisma.service.js';
import { TenantContextService } from './tenant-context.service.js';

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
 * Apply at the controller level alongside `RoleGuard`. Falls through
 * harmlessly when the route isn't project-scoped (no `:projectSlug`
 * param) or when the request method is safe.
 */
@Injectable()
export class DemoProjectGuard implements CanActivate {
  private readonly logger = new Logger(DemoProjectGuard.name);

  constructor(
    private prisma: PrismaService,
    private tenant: TenantContextService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<Request>();
    if (SAFE_METHODS.has(req.method)) return true;
    if (process.env.MERGECREW_DEMO_MODE === '1') return true;

    const projectSlug = (req.params as Record<string, string> | undefined)?.projectSlug;
    if (!projectSlug) return true;

    const t = this.tenant.current();
    if (!t) return true; // RoleGuard will reject auth before us if needed.

    const project = await this.prisma.withTenant(t.organizationId, (tx) =>
      tx.project.findFirst({
        where: { organizationId: t.organizationId, slug: projectSlug, deletedAt: null },
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
