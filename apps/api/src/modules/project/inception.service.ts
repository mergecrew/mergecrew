import { Injectable } from '@nestjs/common';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { GitHubProvider, getGitHubAppCredentials } from '@mergecrew/adapters-vcs';
import { effectiveBaseBranch } from '@mergecrew/db';
import { ValidationError } from '@mergecrew/domain';
import { runInception, type InceptionResult } from '@mergecrew/inception';
import { PrismaService } from '../../common/prisma.service.js';
import { TenantContextService } from '../../common/tenant-context.service.js';

/**
 * Project Inception orchestration (V1.1, #7).
 *
 * Clones the project's connected repo into a sandboxed temp dir, runs the
 * pure detector from `@mergecrew/inception`, and returns the structured
 * summary + draft `mergecrew.yaml`. Always cleans up the workspace.
 *
 * The detector itself is in a separate package so the runner / CLI tools
 * can call it offline against any path. This service is just the
 * "fetch+invoke+cleanup" wrapper that knows how to find the repo.
 */
@Injectable()
export class InceptionService {
  constructor(
    private prisma: PrismaService,
    private tenant: TenantContextService,
  ) {}

  async run(projectSlug: string): Promise<InceptionResult> {
    const t = this.tenant.require();
    const project = await this.prisma.withTenant(t.organizationId, (tx) =>
      tx.project.findFirst({
        where: { slug: projectSlug, organizationId: t.organizationId },
        include: { connectedRepo: true },
      }),
    );
    if (!project) throw new ValidationError('project not found');
    const repo = project.connectedRepo;
    if (!repo) {
      throw new ValidationError(
        'no repository connected — install the GitHub App and connect a repo first',
      );
    }
    const creds = getGitHubAppCredentials();
    if (!creds) {
      throw new ValidationError(
        'inception requires GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY to clone the repo',
      );
    }

    const vcs = new GitHubProvider(creds);

    const workspace = await mkdtemp(path.join(tmpdir(), 'mergecrew-inception-'));
    try {
      const baseBranch = effectiveBaseBranch(repo);
      await vcs.cloneIntoWorkspace(
        {
          installationId: repo.installationId,
          repoId: repo.repoId ?? undefined,
          repoFullName: repo.repoFullName,
          defaultBranch: baseBranch,
        },
        baseBranch,
        workspace,
      );
      return await runInception(workspace);
    } finally {
      await rm(workspace, { recursive: true, force: true }).catch(() => {});
    }
  }
}
