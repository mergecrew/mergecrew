import { Injectable, Logger } from '@nestjs/common';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execa, type ExecaError } from 'execa';
import { GitHubProvider, type VcsProvider } from '@mergecrew/adapters-vcs';
import { effectiveBaseBranch, Prisma, type PromoteRun } from '@mergecrew/db';
import { NotFoundError, ValidationError, interpolateTagPattern } from '@mergecrew/domain';
import { PrismaService } from '../../common/prisma.service.js';
import { TenantContextService } from '../../common/tenant-context.service.js';

interface ApprovedChangeset {
  id: string;
  prNumber: number;
}

/**
 * Release-branch cherry-pick engine (#471).
 *
 * Builds the prod artifact by cherry-picking the human-approved subset
 * of dev changesets onto a fresh branch off `PromotionStrategy.releaseBranch`,
 * then triggers the user's CI per `PromotionStrategy.kind`:
 *
 *   - `auto_deploy`     — push the release branch; user's CI fires.
 *   - `manual_workflow` — push + dispatch a workflow_dispatch.
 *   - `tag_driven`      — push + push an annotated tag.
 *   - `deferred`        — rejected at the boundary (422).
 *
 * On the first cherry-pick conflict the engine stops cleanly, pushes
 * the half-built branch so the user can resolve it in their editor,
 * records the offending changeset + files on the PromoteRun, and
 * returns. Re-running with the same approved list (after the user
 * fixes the merge upstream) restarts from a fresh branch.
 *
 * v1 is synchronous: cherry-pick of a few commits takes milliseconds.
 * If we ever need to promote dozens at a time, this becomes
 * BullMQ-backed and the endpoint returns the PromoteRun id immediately.
 */
@Injectable()
export class PromoteService {
  private readonly logger = new Logger(PromoteService.name);

  constructor(
    private prisma: PrismaService,
    private tenant: TenantContextService,
  ) {}

  /**
   * Bundle the promote digest UI needs in one round-trip: the
   * promotable changesets, the latest PromoteRun (for conflict
   * surface), and the project's strategy (for the deferred-state
   * branch). Filter is strict: a row is promotable iff it has a
   * merged PR (`prNumber` set), hasn't shipped (`lastPromoteRunId is
   * null`), and hasn't been dropped (`droppedAt is null`). Status
   * `dev_deployed` is the only state the cherry-pick engine can
   * actually use — earlier states (`proposed`, `pr_open`, …) don't
   * have a merge commit yet.
   */
  async digest(projectSlug: string): Promise<{
    changesets: Array<{
      id: string;
      title: string;
      whyParagraph: string | null;
      prNumber: number | null;
      prUrl: string | null;
      branch: string;
      riskChip: string | null;
      updatedAt: string;
    }>;
    latestRun: PromoteRun | null;
    strategy: { kind: string } | null;
  }> {
    const t = this.tenant.require();
    const project = await this.prisma.withTenant(t.organizationId, (tx) =>
      tx.project.findFirst({
        where: { slug: projectSlug, organizationId: t.organizationId, deletedAt: null },
        select: { id: true, promotionStrategy: { select: { kind: true } } },
      }),
    );
    if (!project) throw new NotFoundError();

    const [rows, latestRun] = await this.prisma.withTenant(t.organizationId, async (tx) => {
      const rs = await tx.changeset.findMany({
        where: {
          projectId: project.id,
          status: 'dev_deployed',
          lastPromoteRunId: null,
          droppedAt: null,
          prNumber: { not: null },
        },
        orderBy: { updatedAt: 'asc' },
        select: {
          id: true,
          title: true,
          whyParagraph: true,
          prNumber: true,
          prUrl: true,
          branch: true,
          riskChip: true,
          updatedAt: true,
        },
      });
      const run = await tx.promoteRun.findFirst({
        where: { projectId: project.id },
        orderBy: { createdAt: 'desc' },
      });
      return [rs, run] as const;
    });

    return {
      changesets: rows.map((r) => ({
        id: r.id,
        title: r.title,
        whyParagraph: r.whyParagraph,
        prNumber: r.prNumber,
        prUrl: r.prUrl,
        branch: r.branch,
        riskChip: r.riskChip,
        updatedAt: r.updatedAt.toISOString(),
      })),
      latestRun,
      strategy: project.promotionStrategy ? { kind: project.promotionStrategy.kind } : null,
    };
  }

  async listRuns(projectSlug: string, limit = 20): Promise<PromoteRun[]> {
    const t = this.tenant.require();
    const project = await this.prisma.withTenant(t.organizationId, (tx) =>
      tx.project.findFirst({
        where: { slug: projectSlug, organizationId: t.organizationId, deletedAt: null },
        select: { id: true },
      }),
    );
    if (!project) throw new NotFoundError();
    return this.prisma.withTenant(t.organizationId, (tx) =>
      tx.promoteRun.findMany({
        where: { projectId: project.id },
        orderBy: { createdAt: 'desc' },
        take: Math.max(1, Math.min(limit, 50)),
      }),
    );
  }

  async promote(
    projectSlug: string,
    approvedChangesetIds: string[],
  ): Promise<PromoteRun> {
    if (!approvedChangesetIds || approvedChangesetIds.length === 0) {
      throw new ValidationError(
        'no_changesets_approved: pick at least one changeset to promote',
      );
    }

    const t = this.tenant.require();
    const project = await this.prisma.withTenant(t.organizationId, (tx) =>
      tx.project.findFirst({
        where: { slug: projectSlug, organizationId: t.organizationId, deletedAt: null },
        include: { connectedRepo: true, promotionStrategy: true },
      }),
    );
    if (!project) throw new NotFoundError();

    const strategy = project.promotionStrategy;
    if (!strategy) {
      throw new ValidationError(
        'no_promotion_strategy: configure how dev graduates to prod in Settings → Promotion strategy',
      );
    }
    if (strategy.kind === 'deferred') {
      throw new ValidationError(
        'promotion_deferred: switch the strategy from "configure later" to a real shape first',
      );
    }
    if (!project.connectedRepo) {
      throw new ValidationError('no_connected_repo: cannot promote without a repo');
    }
    // single_env runs no git operations — short-circuit before the
    // GitHub-App env check so review-only projects work without
    // GitHub Actions credentials configured on the server (#478).
    if (strategy.kind === 'single_env') {
      return this.acceptReviewed(project.id, project.organizationId, approvedChangesetIds);
    }
    if (!process.env.GITHUB_APP_ID || !process.env.GITHUB_APP_PRIVATE_KEY) {
      throw new ValidationError(
        'github_app_not_configured: set GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY on the API',
      );
    }

    // Load the changesets the digest passed up. We require:
    //   - all rows belong to this project
    //   - each has a prNumber (it merged into dev via a PR)
    //   - none are already dropped
    const rows = await this.prisma.withTenant(t.organizationId, (tx) =>
      tx.changeset.findMany({
        where: {
          id: { in: approvedChangesetIds },
          projectId: project.id,
          droppedAt: null,
        },
        select: { id: true, prNumber: true },
      }),
    );
    if (rows.length !== approvedChangesetIds.length) {
      throw new ValidationError(
        'invalid_changesets: one or more changesets are unknown, belong to a different project, or have been dropped',
      );
    }
    const missingPr = rows.find((r) => r.prNumber == null);
    if (missingPr) {
      throw new ValidationError(
        `changeset_not_merged: ${missingPr.id} has no PR; only merged changesets can be promoted`,
      );
    }
    const approved: ApprovedChangeset[] = rows.map((r) => ({
      id: r.id,
      prNumber: r.prNumber as number,
    }));

    const vcs = new GitHubProvider({
      appId: process.env.GITHUB_APP_ID!,
      privateKey: process.env.GITHUB_APP_PRIVATE_KEY!,
    });
    const repoRef = {
      installationId: project.connectedRepo.installationId,
      repoId: project.connectedRepo.repoId ?? undefined,
      repoFullName: project.connectedRepo.repoFullName,
      defaultBranch: effectiveBaseBranch(project.connectedRepo),
    };
    const releaseBranch = strategy.releaseBranch?.trim() || repoRef.defaultBranch;

    // Resolve each changeset's merge commit + chronological merged-at
    // so the cherry-pick order matches the dev branch's history. The
    // approved set from the UI is already in display order but display
    // ≠ merge order if the user reorders cards.
    const prDetails = await Promise.all(
      approved.map(async (c) => ({
        id: c.id,
        pr: await vcs.getMergedPullRequest(repoRef, c.prNumber),
      })),
    );
    for (const d of prDetails) {
      if (!d.pr.mergeCommitSha || !d.pr.mergedAt) {
        throw new ValidationError(
          `changeset_not_merged: PR #${d.pr.number} for changeset ${d.id} is not merged on the host`,
        );
      }
    }
    prDetails.sort((a, b) => {
      const at = a.pr.mergedAt as string;
      const bt = b.pr.mergedAt as string;
      return at < bt ? -1 : at > bt ? 1 : 0;
    });

    const run = await this.prisma.withTenant(t.organizationId, (tx) =>
      tx.promoteRun.create({
        data: {
          organizationId: project.organizationId,
          projectId: project.id,
          status: 'pending',
          approvedChangesetIds: prDetails.map((d) => d.id),
        },
      }),
    );

    const shortSha = (sha: string) => sha.slice(0, 7);
    const datePart = new Date().toISOString().slice(0, 10);
    const newBranch = `mergecrew/release-${datePart}-${shortSha(run.id)}`;

    const workspace = await mkdtemp(path.join(tmpdir(), 'mergecrew-promote-'));
    try {
      await vcs.cloneIntoWorkspace(repoRef, releaseBranch, workspace);
      await vcs.createBranch(workspace, newBranch, releaseBranch);

      // Cherry-pick each approved changeset in merged-at order. Failure
      // stops the loop and records the conflict; partial progress is
      // pushed so the user can resolve in their editor and re-run.
      for (const d of prDetails) {
        const sha = d.pr.mergeCommitSha as string;
        const args = d.pr.isMergeCommit
          ? ['cherry-pick', '-m', '1', sha]
          : ['cherry-pick', sha];
        try {
          await execa('git', args, { cwd: workspace, env: gitEnv() });
        } catch (err) {
          const files = await this.conflictedFiles(workspace);
          // Abort cleans the working tree so a re-run picks up cleanly
          // after the user fixes things upstream; we keep the half-
          // built branch on the remote for visibility.
          await execa('git', ['cherry-pick', '--abort'], {
            cwd: workspace,
            env: gitEnv(),
            reject: false,
          });
          // Push the partial branch with whatever cleanly cherry-picked
          // before the conflict, so the user has something to look at.
          await this.pushSafely(vcs, workspace, newBranch);
          this.logger.warn(
            { runId: run.id, changesetId: d.id, prNumber: d.pr.number, err: errMsg(err) },
            'promote: cherry-pick conflict',
          );
          return this.finishRun(run.id, {
            status: 'conflict',
            releaseRef: newBranch,
            conflict: { changesetId: d.id, files },
          });
        }
      }

      await vcs.push(workspace, newBranch);

      // Per-strategy trigger. Errors here aren't conflicts — they're
      // failures (push went through, but dispatch/tag didn't). The
      // user can re-trigger from the digest without rebuilding.
      try {
        if (strategy.kind === 'manual_workflow') {
          if (!strategy.workflowFilename) {
            throw new ValidationError(
              'manual_workflow strategy missing workflowFilename',
            );
          }
          const inputs: Record<string, string> = {};
          if (strategy.envInputKey && strategy.envInputValue) {
            inputs[strategy.envInputKey] = strategy.envInputValue;
          }
          await vcs.dispatchWorkflow(repoRef, {
            workflowFilename: strategy.workflowFilename,
            ref: newBranch,
            inputs,
          });
        } else if (strategy.kind === 'tag_driven') {
          const pattern = strategy.tagPattern || 'v${YYYY-MM-DD}-${shortSha}';
          const headSha = (
            await execa('git', ['rev-parse', 'HEAD'], { cwd: workspace, env: gitEnv() })
          ).stdout.trim();
          const tagName = interpolateTagPattern(pattern, headSha);
          await execa(
            'git',
            ['tag', '-a', tagName, '-m', `mergecrew release ${tagName}`],
            { cwd: workspace, env: gitEnv() },
          );
          await execa('git', ['push', 'origin', tagName], {
            cwd: workspace,
            env: gitEnv(),
          });
          await this.recordReleaseRef(run.id, tagName);
        }
      } catch (err) {
        this.logger.error(
          { runId: run.id, kind: strategy.kind, err: errMsg(err) },
          'promote: strategy trigger failed',
        );
        return this.finishRun(run.id, {
          status: 'failed',
          releaseRef: newBranch,
          failureReason: `${strategy.kind}: ${errMsg(err)}`,
        });
      }

      // Stamp lastPromoteRunId on each shipped changeset so the digest
      // can render "shipped in <runId>" and exclude them next cycle.
      await this.prisma.withTenant(t.organizationId, (tx) =>
        tx.changeset.updateMany({
          where: { id: { in: prDetails.map((d) => d.id) }, projectId: project.id },
          data: { lastPromoteRunId: run.id, updatedAt: new Date() },
        }),
      );

      return this.finishRun(run.id, {
        status: 'completed',
        releaseRef: newBranch,
      });
    } catch (err) {
      this.logger.error(
        { runId: run.id, err: errMsg(err) },
        'promote: engine failed before completion',
      );
      return this.finishRun(run.id, {
        status: 'failed',
        failureReason: errMsg(err),
      });
    } finally {
      await rm(workspace, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private async pushSafely(
    vcs: VcsProvider,
    workspace: string,
    branch: string,
  ): Promise<void> {
    try {
      await vcs.push(workspace, branch);
    } catch (err) {
      this.logger.warn(
        { branch, err: errMsg(err) },
        'promote: partial-branch push failed (non-fatal)',
      );
    }
  }

  private async conflictedFiles(workspace: string): Promise<string[]> {
    try {
      const r = await execa(
        'git',
        ['diff', '--name-only', '--diff-filter=U'],
        { cwd: workspace, env: gitEnv() },
      );
      return r.stdout.split('\n').map((l: string) => l.trim()).filter(Boolean);
    } catch {
      return [];
    }
  }

  private async finishRun(
    id: string,
    patch: {
      status: 'pending' | 'conflict' | 'completed' | 'failed';
      releaseRef?: string;
      conflict?: { changesetId: string; files: string[] };
      failureReason?: string;
    },
  ): Promise<PromoteRun> {
    const t = this.tenant.require();
    return this.prisma.withTenant(t.organizationId, (tx) =>
      tx.promoteRun.update({
        where: { id },
        data: {
          status: patch.status,
          releaseRef: patch.releaseRef,
          conflict: patch.conflict
            ? (patch.conflict as unknown as Prisma.InputJsonValue)
            : Prisma.JsonNull,
          failureReason: patch.failureReason ?? null,
          finishedAt: new Date(),
        },
      }),
    );
  }

  private async recordReleaseRef(id: string, releaseRef: string): Promise<void> {
    const t = this.tenant.require();
    await this.prisma.withTenant(t.organizationId, (tx) =>
      tx.promoteRun.update({ where: { id }, data: { releaseRef } }),
    );
  }

  /**
   * single_env path (#478): no cherry-pick, no push, no dispatch.
   * Create a completed PromoteRun, stamp lastPromoteRunId on the
   * approved changesets so they leave the digest, emit an audit log
   * entry per accepted changeset. The digest UI renames the CTA to
   * "Mark reviewed" for this kind so the verb matches reality.
   */
  private async acceptReviewed(
    projectId: string,
    organizationId: string,
    approvedChangesetIds: string[],
  ): Promise<PromoteRun> {
    const t = this.tenant.require();
    // Re-validate ownership + non-dropped (the early validation already
    // covered this for `approved` but acceptReviewed is reachable
    // independently if future code paths call it).
    const rows = await this.prisma.withTenant(t.organizationId, (tx) =>
      tx.changeset.findMany({
        where: {
          id: { in: approvedChangesetIds },
          projectId,
          droppedAt: null,
        },
        select: { id: true },
      }),
    );
    if (rows.length !== approvedChangesetIds.length) {
      throw new ValidationError(
        'invalid_changesets: one or more changesets are unknown or already dropped',
      );
    }

    const run = await this.prisma.withTenant(t.organizationId, (tx) =>
      tx.promoteRun.create({
        data: {
          organizationId,
          projectId,
          status: 'completed',
          releaseRef: null,
          approvedChangesetIds: rows.map((r) => r.id),
          finishedAt: new Date(),
        },
      }),
    );

    await this.prisma.withTenant(t.organizationId, (tx) =>
      tx.changeset.updateMany({
        where: { id: { in: rows.map((r) => r.id) }, projectId },
        data: { lastPromoteRunId: run.id, updatedAt: new Date() },
      }),
    );

    // Audit-log entry per accepted changeset. Free-form metadata keeps
    // the row useful even before any UI consumes it.
    await this.prisma.withTenant(t.organizationId, (tx) =>
      tx.auditLogEntry.createMany({
        data: rows.map((r) => ({
          organizationId,
          actorUserId: t.userId,
          action: 'changeset.accepted',
          target: { changesetId: r.id, projectId } as Prisma.InputJsonValue,
          metadata: { promoteRunId: run.id, strategyKind: 'single_env' } as Prisma.InputJsonValue,
        })),
      }),
    );

    return run;
  }
}

function gitEnv(): NodeJS.ProcessEnv {
  return { ...process.env, GIT_TERMINAL_PROMPT: '0' };
}

function errMsg(err: unknown): string {
  if (err instanceof Error) {
    const e = err as ExecaError;
    return e.stderr || e.stdout || err.message;
  }
  return String(err);
}

