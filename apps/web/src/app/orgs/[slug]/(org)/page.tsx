import Link from 'next/link';
import { revalidatePath } from 'next/cache';
import { api } from '@/lib/api';
import { requireSession } from '@/lib/session';
import { Card, StatusDot, LinkButton, Chip, PageHead, Tile, Label } from '@/components/ui';
import { FirstRunEmptyState } from '@/components/first-run-empty-state';
import { OrgSetupCard } from '@/components/org-setup-card';
import { PauseRunsControl } from '@/components/pause-runs-control';
import { relativeTime, runStatusToDot } from '@/lib/format';

type OrgDetail = {
  id: string;
  slug: string;
  name: string;
  runsPausedAt?: string | null;
  runsPauseReason?: string | null;
  runsPausedByUserId?: string | null;
};

type Project = {
  id: string;
  slug: string;
  name: string;
  description?: string | null;
  demo?: boolean;
};

type Run = {
  id: string;
  status: string;
  scheduledAt: string;
  startedAt?: string | null;
  completedAt?: string | null;
};

type ApprovalRequest = {
  id: string;
  projectId: string;
  createdAt: string;
};

type TimelineEvent = {
  id: string;
  type: string;
  occurredAt: string;
  projectId?: string | null;
  payload?: Record<string, unknown>;
};

export default async function OrgHomePage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const session = await requireSession();

  const [orgRes, projectsRes, inboxRes, activityRes, spendCapRes, evalsRes, onboardingRes] =
    await Promise.all([
      safe(() => api<OrgDetail>(`/v1/orgs/${slug}`, { session })),
      safe(() => api<{ items: Project[] }>(`/v1/orgs/${slug}/projects`, { session })),
      safe(() => api<{ items: ApprovalRequest[] }>(`/v1/orgs/${slug}/inbox`, { session })),
      safe(() =>
        api<{ items: TimelineEvent[] }>(`/v1/orgs/${slug}/activity?limit=10`, { session }),
      ),
      safe(() =>
        api<{
          monthlySpendCapUsd: number | null;
          projectedMonthEndUsd: number;
          daysToCapExceedance: number | null;
          projectionExceedsCap: boolean;
        }>(`/v1/orgs/${slug}/spend-cap`, { session }),
      ),
      safe(() =>
        api<{
          items: Array<{
            id: string;
            startedAt: string;
            finishedAt: string | null;
            totalCases: number;
            passCount: number;
            source: string;
          }>;
        }>(`/v1/orgs/${slug}/evals?limit=1`, { session }),
      ),
      safe(() =>
        api<{
          steps: Array<{ status: 'complete' | 'pending' }>;
          complete: boolean;
        }>(`/v1/orgs/${slug}/onboarding`, { session }),
      ),
    ]);

  const projects = projectsRes?.items ?? [];
  const inbox = inboxRes?.items ?? [];
  const activity = activityRes?.items ?? [];
  const spendCap = spendCapRes;
  const latestEval = evalsRes?.items?.[0] ?? null;
  const evalPassRate =
    latestEval && latestEval.totalCases > 0
      ? latestEval.passCount / latestEval.totalCases
      : null;

  const latestRuns = await Promise.all(
    projects.map((p) =>
      safe(() =>
        api<{ items: Run[] }>(
          `/v1/orgs/${slug}/projects/${p.slug}/runs?limit=1`,
          { session },
        ),
      ).then((r) => r?.items?.[0] ?? null),
    ),
  );

  const approvalsByProject = new Map<string, number>();
  for (const a of inbox) {
    approvalsByProject.set(a.projectId, (approvalsByProject.get(a.projectId) ?? 0) + 1);
  }

  const projectIdToSlug = new Map(projects.map((p) => [p.id, p.slug] as const));
  const orgPaused = Boolean(orgRes?.runsPausedAt);

  const pauseOrgRunsAction = async (reason: string | null) => {
    'use server';
    const s = await requireSession();
    try {
      await api(`/v1/orgs/${slug}/pause`, {
        method: 'POST',
        body: JSON.stringify({ reason }),
        session: s,
      });
      revalidatePath(`/orgs/${slug}`);
      return { ok: true } as const;
    } catch (e: unknown) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) } as const;
    }
  };
  const resumeOrgRunsAction = async () => {
    'use server';
    const s = await requireSession();
    try {
      await api(`/v1/orgs/${slug}/resume`, { method: 'POST', body: '{}', session: s });
      revalidatePath(`/orgs/${slug}`);
      return { ok: true } as const;
    } catch (e: unknown) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) } as const;
    }
  };

  return (
    <main className="mx-auto max-w-[1280px] px-4 py-5 sm:px-9 sm:py-7">
      <PageHead
        crumb={[{ label: slug }]}
        title="Today"
        meta={
          <div className="flex flex-wrap items-center gap-3">
            {orgPaused && <Chip kind="high">ORG PAUSED</Chip>}
            <span className="font-mono text-[12.5px] text-muted">
              {new Date().toDateString()}
            </span>
          </div>
        }
        actions={
          <PauseRunsControl
            paused={orgPaused}
            pauseAction={pauseOrgRunsAction}
            resumeAction={resumeOrgRunsAction}
            scopeLabel="all org runs"
          />
        }
      />

      {orgPaused && (
        <div className="mb-6 border border-energy bg-energy-soft p-4" role="status">
          <div className="text-[13.5px] font-medium text-energy-deep">
            Org-wide pause is active
          </div>
          <p className="mt-1 text-[12.5px] text-energy-deep/80">
            Paused {relativeTime(orgRes!.runsPausedAt!)}
            {orgRes!.runsPauseReason ? ` — ${orgRes!.runsPauseReason}` : ''}. No runs will fire
            on any project until resumed.
          </p>
        </div>
      )}

      {onboardingRes && !onboardingRes.complete && (
        <div className="mb-6">
          <OrgSetupCard
            orgSlug={slug}
            totalSteps={onboardingRes.steps.length}
            pendingSteps={onboardingRes.steps.filter((s) => s.status === 'pending').length}
            demoProjectSlug={projects.find((p) => p.demo)?.slug ?? null}
          />
        </div>
      )}

      <section className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-4">
        <Tile k="Projects" v={String(projects.length)} />
        <Tile
          k="Pending approvals"
          v={String(inbox.length)}
          energy={inbox.length > 0}
          n={inbox.length > 0 ? 'blocking next run' : 'none'}
        />
        <Tile
          k="Status"
          v={orgPaused ? 'paused' : 'running'}
          energy={orgPaused}
          positive={!orgPaused}
        />
        <Tile
          k="Eval pass-rate"
          v={evalPassRate != null ? `${(evalPassRate * 100).toFixed(0)}%` : '—'}
          positive={evalPassRate != null && evalPassRate >= 0.95}
          energy={evalPassRate != null && evalPassRate < 0.8}
          n={latestEval?.source ?? 'no evals yet'}
        />
      </section>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1.4fr_1fr]">
        <div className="space-y-6">
          <section>
            <div className="mb-3 flex items-center justify-between">
              <Label>Projects {projects.length > 0 ? `(${projects.length})` : ''}</Label>
              {projects.length > 0 && (
                <LinkButton href={`/orgs/${slug}/projects/new`} variant="ghost" size="sm">
                  New project
                </LinkButton>
              )}
            </div>
            {projects.length === 0 ? (
              <FirstRunEmptyState orgSlug={slug} />
            ) : (
              <ul className="m-0 grid grid-cols-1 gap-3 list-none p-0 md:grid-cols-2">
                {projects.map((p, i) => {
                  const run = latestRuns[i];
                  const approvalCount = approvalsByProject.get(p.id) ?? 0;
                  return (
                    <li key={p.id}>
                      <Link
                        href={`/orgs/${slug}/projects/${p.slug}`}
                        className="block h-full no-underline"
                      >
                        <div className="h-full border border-hair bg-paper p-4 transition-colors hover:border-accent hover:bg-paper-2">
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-2">
                                <StatusDot
                                  status={run ? runStatusToDot(run.status) : 'idle'}
                                />
                                <span className="text-[14px] font-medium tracking-[-0.005em] text-ink">
                                  {p.name}
                                </span>
                                <span className="font-mono text-[11.5px] text-muted">
                                  /{p.slug}
                                </span>
                                {p.demo && <Chip kind="medium">DEMO</Chip>}
                              </div>
                              {p.description && (
                                <p className="mt-2 line-clamp-2 text-[13px] leading-[1.5] text-ink-2">
                                  {p.description}
                                </p>
                              )}
                              <div className="mt-3 flex flex-wrap items-center gap-2 font-mono text-[11.5px] text-muted">
                                {run ? (
                                  <>
                                    <span>{run.status}</span>
                                    <span>·</span>
                                    <span>
                                      {relativeTime(run.startedAt ?? run.scheduledAt)}
                                    </span>
                                  </>
                                ) : (
                                  <span>No runs yet</span>
                                )}
                              </div>
                            </div>
                            {approvalCount > 0 && (
                              <Chip kind="medium">{approvalCount} pending</Chip>
                            )}
                          </div>
                        </div>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          {activity.length > 0 && (
            <section>
              <div className="mb-3 flex items-center justify-between">
                <Label>Recent activity</Label>
                <LinkButton href={`/orgs/${slug}/activity`} variant="ghost" size="sm">
                  View all
                </LinkButton>
              </div>
              <Card>
                <ul className="m-0 list-none p-0">
                  {activity.map((e, i) => {
                    const projSlug = e.projectId
                      ? projectIdToSlug.get(e.projectId)
                      : undefined;
                    const href = projSlug
                      ? `/orgs/${slug}/projects/${projSlug}`
                      : `/orgs/${slug}/activity`;
                    return (
                      <li
                        key={e.id}
                        className={i < activity.length - 1 ? 'border-b border-hair-2' : ''}
                      >
                        <Link
                          href={href}
                          className="flex items-center justify-between gap-3 px-4 py-3 text-[13px] text-ink no-underline hover:bg-paper-2"
                        >
                          <div className="flex items-center gap-3">
                            <span className="bg-accent-tint px-[8px] py-[2px] font-mono text-[10.5px] uppercase tracking-[0.06em] text-accent-deep">
                              {e.type}
                            </span>
                            {projSlug && (
                              <span className="font-mono text-[12px] text-ink-2">
                                {projSlug}
                              </span>
                            )}
                          </div>
                          <span className="font-mono text-[11.5px] text-muted">
                            {relativeTime(e.occurredAt)}
                          </span>
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              </Card>
            </section>
          )}
        </div>

        <div className="space-y-6">
          {inbox.length > 0 && (
            <Card className="border-energy p-5">
              <Label className="!text-energy-deep">Approval inbox</Label>
              <div className="mt-2 text-[14px] font-medium">
                {inbox.length} pending decision{inbox.length === 1 ? '' : 's'}
              </div>
              <p className="mt-1 text-[12.5px] text-ink-2">
                Decisions block the next run. Resolve them in the inbox.
              </p>
              <LinkButton
                href={`/orgs/${slug}/inbox`}
                variant="energy"
                size="sm"
                className="mt-3"
              >
                Open inbox →
              </LinkButton>
            </Card>
          )}

          {spendCap?.monthlySpendCapUsd != null && (
            <Card className="p-5">
              <Label>Spend cap</Label>
              <div className="mt-2 grid grid-cols-2 gap-3 text-[12.5px]">
                <div>
                  <div className="text-muted">Projected month-end</div>
                  <div
                    className={`mt-1 font-mono text-[18px] ${
                      spendCap.projectionExceedsCap ? 'text-energy-deep' : 'text-ink'
                    }`}
                  >
                    ${spendCap.projectedMonthEndUsd.toFixed(0)}
                  </div>
                </div>
                <div>
                  <div className="text-muted">Monthly cap</div>
                  <div className="mt-1 font-mono text-[18px] text-ink">
                    ${spendCap.monthlySpendCapUsd.toFixed(0)}
                  </div>
                </div>
              </div>
              {spendCap.projectionExceedsCap && (
                <p className="mt-3 text-[12.5px] text-energy-deep">
                  On track to exceed cap.
                  {spendCap.daysToCapExceedance != null && (
                    <> Cap likely hit around day {spendCap.daysToCapExceedance}.</>
                  )}
                </p>
              )}
              <LinkButton
                href={`/orgs/${slug}/settings`}
                variant="ghost"
                size="sm"
                className="mt-3"
              >
                Adjust cap
              </LinkButton>
            </Card>
          )}

          {latestEval && (
            <Card className="p-5">
              <Label>Latest eval</Label>
              <div className="mt-2 font-mono text-[12.5px] text-muted">
                {latestEval.source} · {relativeTime(latestEval.startedAt)}
              </div>
              <div
                className={`mt-2 text-[32px] font-medium tracking-[-0.025em] ${
                  evalPassRate != null && evalPassRate >= 0.95
                    ? 'text-positive-deep'
                    : evalPassRate != null && evalPassRate >= 0.8
                      ? 'text-ink'
                      : 'text-energy-deep'
                }`}
              >
                {evalPassRate != null ? `${(evalPassRate * 100).toFixed(0)}%` : '—'}
              </div>
              <div className="mt-1 font-mono text-[11.5px] text-muted">
                {latestEval.passCount}/{latestEval.totalCases} cases passing
              </div>
              <LinkButton
                href={`/orgs/${slug}/evals`}
                variant="ghost"
                size="sm"
                className="mt-3"
              >
                View evals
              </LinkButton>
            </Card>
          )}
        </div>
      </div>
    </main>
  );
}

async function safe<T>(fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch {
    return null;
  }
}
