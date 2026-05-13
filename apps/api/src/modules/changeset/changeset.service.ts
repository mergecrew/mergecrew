import { Injectable } from '@nestjs/common';
import { NotFoundError, GateRequiredError, ValidationError, type DecisionKind } from '@mergecrew/domain';
import { GitHubProvider, type PullRequestFile } from '@mergecrew/adapters-vcs';
import { PrismaService } from '../../common/prisma.service.js';
import { TenantContextService } from '../../common/tenant-context.service.js';
import { QueueService } from '../../common/queue.service.js';
import { EventlogService } from '../../common/eventlog.service.js';

@Injectable()
export class ChangesetService {
  constructor(
    private prisma: PrismaService,
    private tenant: TenantContextService,
    private queue: QueueService,
    private elSvc: EventlogService,
  ) {}

  async list(projectSlug: string, opts: { status?: string; runId?: string }) {
    const t = this.tenant.require();
    const project = await this.prisma.withTenant(t.organizationId, (tx) =>
      tx.project.findFirst({ where: { slug: projectSlug, organizationId: t.organizationId } }),
    );
    if (!project) throw new NotFoundError();
    return this.prisma.withTenant(t.organizationId, (tx) =>
      tx.changeset.findMany({
        where: {
          projectId: project.id,
          ...(opts.status ? { status: opts.status as any } : {}),
          ...(opts.runId ? { dailyRunId: opts.runId } : {}),
        },
        orderBy: { updatedAt: 'desc' },
      }),
    );
  }

  async get(csId: string) {
    const t = this.tenant.require();
    const r = await this.prisma.withTenant(t.organizationId, (tx) =>
      tx.changeset.findFirst({ where: { id: csId, organizationId: t.organizationId } }),
    );
    if (!r) throw new NotFoundError();
    // Agent-review state (#421, V2.al). Computed from the latest
    // CHANGESET_REVIEW_POSTED event the runner emitted for this
    // changeset (#420). Folded into the detail response so the
    // changeset page renders a chip without a second request.
    // Three states the page cares about:
    //   pending          — PR open as draft, reviewer hasn't run yet
    //   request_changes  — reviewer requested changes (still draft)
    //   approve          — reviewer approved (PR flipped to ready-for-review)
    // Absent for changesets without a PR or runs that don't use a Reviewer agent.
    const latestReview = await this.prisma.withTenant(t.organizationId, (tx) =>
      tx.timelineEvent.findFirst({
        where: { changesetId: csId, type: 'CHANGESET_REVIEW_POSTED' },
        orderBy: { occurredAt: 'desc' },
        select: { payload: true, occurredAt: true },
      }),
    );
    const reviewPayload = latestReview?.payload as
      | { verdict?: 'approve' | 'request_changes'; flippedToReady?: boolean }
      | null
      | undefined;
    const agentReview = reviewPayload?.verdict
      ? {
          verdict: reviewPayload.verdict,
          flippedToReady: !!reviewPayload.flippedToReady,
          at: latestReview?.occurredAt ?? null,
        }
      : null;
    return { ...r, agentReview };
  }

  async digestFor(projectSlug: string, dateISO: string) {
    const t = this.tenant.require();
    const project = await this.prisma.withTenant(t.organizationId, (tx) =>
      tx.project.findFirst({ where: { slug: projectSlug, organizationId: t.organizationId } }),
    );
    if (!project) throw new NotFoundError();
    const start = new Date(dateISO);
    const end = new Date(start.getTime() + 24 * 3600_000);
    const items = await this.prisma.withTenant(t.organizationId, (tx) =>
      tx.changeset.findMany({
        where: {
          projectId: project.id,
          updatedAt: { gte: start, lt: end },
        },
        orderBy: { updatedAt: 'desc' },
      }),
    );
    return {
      date: dateISO.slice(0, 10),
      items,
      totalCost: items.reduce((s, c) => s + Number(c.estimatedUsd), 0),
    };
  }

  async decide(csId: string, kind: DecisionKind, comment?: string) {
    const t = this.tenant.require();
    const cs = await this.get(csId);

    // Hard product invariant: production promote requires operator+.
    if (kind === 'promote' && t.role !== 'owner' && t.role !== 'admin' && t.role !== 'operator') {
      throw new GateRequiredError('production_promote', 'operator');
    }

    const decision = await this.prisma.withTenant(t.organizationId, (tx) =>
      tx.decision.create({
        data: {
          organizationId: t.organizationId,
          changesetId: csId,
          userId: t.userId,
          kind,
          comment: comment ?? null,
        },
      }),
    );

    await this.prisma.withTenant(t.organizationId, (tx) =>
      tx.changeset.update({
        where: { id: csId },
        data: {
          status: kind === 'promote' ? 'promoted' : kind === 'rollback' ? 'rolled_back' : 'deferred',
          updatedAt: new Date(),
        },
      }),
    );

    if (kind === 'promote') {
      await this.queue.get('orchestrator.dispatch').add(
        'promote',
        { changesetId: csId, organizationId: t.organizationId, userId: t.userId },
        { removeOnComplete: 1000 },
      );
    } else if (kind === 'rollback') {
      await this.queue.get('orchestrator.dispatch').add(
        'rollback',
        { changesetId: csId, organizationId: t.organizationId, userId: t.userId },
        { removeOnComplete: 1000 },
      );
    }

    await this.elSvc.eventlog.emit({
      organizationId: t.organizationId,
      projectId: cs.projectId,
      dailyRunId: cs.dailyRunId,
      changesetId: csId,
      type:
        kind === 'promote'
          ? 'CHANGESET_PROMOTED'
          : kind === 'rollback'
            ? 'CHANGESET_ROLLED_BACK'
            : 'AGENT_DECISION',
      actor: { kind: 'user', id: t.userId },
      payload: { kind, comment: comment ?? null, decisionId: decision.id },
    });

    return decision;
  }

  async getDiff(csId: string): Promise<{ prNumber: number; files: PullRequestFile[] }> {
    const t = this.tenant.require();
    const cs = await this.prisma.withTenant(t.organizationId, (tx) =>
      tx.changeset.findFirst({ where: { id: csId, organizationId: t.organizationId } }),
    );
    if (!cs) throw new NotFoundError();
    if (!cs.prNumber) {
      throw new ValidationError('changeset has no open PR — diff is not available yet');
    }
    const repo = await this.prisma.withTenant(t.organizationId, (tx) =>
      tx.connectedRepo.findUnique({ where: { projectId: cs.projectId } }),
    );
    if (!repo) {
      throw new ValidationError('project has no connected repo — cannot fetch diff');
    }
    if (!process.env.GITHUB_APP_ID || !process.env.GITHUB_APP_PRIVATE_KEY) {
      throw new ValidationError('GitHub App not configured on this server');
    }
    const provider = new GitHubProvider({
      appId: process.env.GITHUB_APP_ID,
      privateKey: process.env.GITHUB_APP_PRIVATE_KEY,
    });
    const files = await provider.getPullRequestFiles(
      {
        installationId: repo.installationId,
        repoFullName: repo.repoFullName,
        defaultBranch: repo.defaultBranch,
      },
      cs.prNumber,
    );
    return { prNumber: cs.prNumber, files };
  }

  /**
   * One-click rollback (#287). Opens a `git revert` PR via the VCS
   * adapter for an already-merged changeset, then marks the row
   * rolled_back and writes an audit entry. The detail page reads the
   * stamped `revertPrNumber + revertPrUrl` to render a link.
   *
   * Migrations caveat: if any path in the original PR matches
   * `**\/migration*` we surface the warning in the response so the UI
   * shows the operator before they click confirm — but we don't refuse
   * the action, only document the consequence.
   */
  async rollback(csId: string): Promise<{
    ok: true;
    revertPrNumber: number;
    revertPrUrl: string;
    migrationsWarning: boolean;
    migrationFiles: string[];
  }> {
    const t = this.tenant.require();
    const cs = await this.prisma.withTenant(t.organizationId, (tx) =>
      tx.changeset.findFirst({ where: { id: csId, organizationId: t.organizationId } }),
    );
    if (!cs) throw new NotFoundError();
    if (cs.status !== 'promoted') {
      throw new ValidationError(
        `rollback requires status=promoted, got ${cs.status}. Only merged changesets can be rolled back.`,
      );
    }
    if (!cs.prNumber) {
      throw new ValidationError('changeset has no PR number — nothing to revert');
    }
    if (cs.revertPrNumber) {
      throw new ValidationError(
        `changeset already rolled back via PR #${cs.revertPrNumber}`,
      );
    }
    const repo = await this.prisma.withTenant(t.organizationId, (tx) =>
      tx.connectedRepo.findUnique({ where: { projectId: cs.projectId } }),
    );
    if (!repo) {
      throw new ValidationError('project has no connected repo — cannot open revert PR');
    }
    if (!process.env.GITHUB_APP_ID || !process.env.GITHUB_APP_PRIVATE_KEY) {
      throw new ValidationError('GitHub App not configured on this server');
    }
    const provider = new GitHubProvider({
      appId: process.env.GITHUB_APP_ID,
      privateKey: process.env.GITHUB_APP_PRIVATE_KEY,
    });
    const repoRef = {
      installationId: repo.installationId,
      repoId: repo.repoId ?? undefined,
      repoFullName: repo.repoFullName,
      defaultBranch: repo.defaultBranch,
    };

    // Pre-flight: enumerate files in the original PR so the response
    // can flag the migrations caveat. Best-effort — a fetch failure
    // doesn't block the revert; the caveat just goes unmentioned.
    let migrationFiles: string[] = [];
    try {
      const files = await provider.getPullRequestFiles(repoRef, cs.prNumber);
      migrationFiles = files
        .map((f) => f.path)
        .filter((p) => /(^|\/)migrations?\//i.test(p) || /\/prisma\/migrations\//i.test(p));
    } catch {
      /* swallow — caveat detection is non-essential */
    }

    const { revertPrNumber } = await provider.revertPullRequest(repoRef, cs.prNumber);
    // GitHub-style revert PR URL — the provider only returns the number,
    // not the URL, but the URL is mechanical from the repo + number.
    const revertPrUrl = `https://github.com/${repo.repoFullName}/pull/${revertPrNumber}`;

    await this.prisma.withTenant(t.organizationId, (tx) =>
      tx.changeset.update({
        where: { id: csId },
        data: {
          status: 'rolled_back',
          revertPrNumber,
          revertPrUrl,
          updatedAt: new Date(),
        },
      }),
    );
    await this.prisma.withTenant(t.organizationId, (tx) =>
      tx.auditLogEntry.create({
        data: {
          organizationId: t.organizationId,
          actorUserId: t.userId,
          action: 'changeset.rollback_initiated',
          target: { changesetId: csId, projectId: cs.projectId },
          metadata: {
            originalPrNumber: cs.prNumber,
            revertPrNumber,
            revertPrUrl,
            migrationsTouched: migrationFiles,
          },
        },
      }),
    );
    await this.elSvc.eventlog.emit({
      organizationId: t.organizationId,
      projectId: cs.projectId,
      dailyRunId: cs.dailyRunId,
      changesetId: csId,
      type: 'CHANGESET_ROLLED_BACK',
      actor: { kind: 'user', id: t.userId },
      payload: { revertPrNumber, revertPrUrl, source: 'one_click' },
    });

    return {
      ok: true,
      revertPrNumber,
      revertPrUrl,
      migrationsWarning: migrationFiles.length > 0,
      migrationFiles,
    };
  }

  /**
   * Recent rollbacks for a project (#289). Surfaces the last N
   * one-click rollback events on the project Guardrails settings
   * card so operators have a passive audit trail without needing to
   * open the full audit log.
   */
  async recentRollbacks(projectSlug: string, limit = 3) {
    const t = this.tenant.require();
    const project = await this.prisma.withTenant(t.organizationId, (tx) =>
      tx.project.findFirst({ where: { slug: projectSlug, organizationId: t.organizationId } }),
    );
    if (!project) throw new NotFoundError();
    const rows = await this.prisma.withTenant(t.organizationId, (tx) =>
      tx.changeset.findMany({
        where: {
          projectId: project.id,
          status: 'rolled_back',
          revertPrNumber: { not: null },
        },
        select: {
          id: true,
          title: true,
          revertPrNumber: true,
          revertPrUrl: true,
          updatedAt: true,
        },
        orderBy: { updatedAt: 'desc' },
        take: Math.max(1, Math.min(limit, 25)),
      }),
    );
    return rows;
  }

  async groupPromote(projectSlug: string, dateISO: string, ids: string[]) {
    const t = this.tenant.require();
    const project = await this.prisma.withTenant(t.organizationId, (tx) =>
      tx.project.findFirst({ where: { slug: projectSlug, organizationId: t.organizationId } }),
    );
    if (!project) throw new NotFoundError();
    const decisions: any[] = [];
    for (const id of ids) {
      decisions.push(await this.decide(id, 'promote'));
    }
    await this.queue.get('orchestrator.dispatch').add(
      'group_promote',
      { projectId: project.id, organizationId: t.organizationId, ids },
      { removeOnComplete: 1000 },
    );
    return { decisions, dateISO };
  }
}
