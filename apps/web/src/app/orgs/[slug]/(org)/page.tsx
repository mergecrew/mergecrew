import Link from 'next/link';
import { revalidatePath } from 'next/cache';
import { api } from '@/lib/api';
import { requireSession } from '@/lib/session';
import { Card, StatusDot, LinkButton, Chip } from '@/components/ui';
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

  const [orgRes, projectsRes, inboxRes, activityRes, spendCapRes, evalsRes, onboardingRes] = await Promise.all([
    safe(() => api<OrgDetail>(`/v1/orgs/${slug}`, { session })),
    safe(() => api<{ items: Project[] }>(`/v1/orgs/${slug}/projects`, { session })),
    safe(() => api<{ items: ApprovalRequest[] }>(`/v1/orgs/${slug}/inbox`, { session })),
    safe(() => api<{ items: TimelineEvent[] }>(`/v1/orgs/${slug}/activity?limit=10`, { session })),
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
  const evalPassRate = latestEval && latestEval.totalCases > 0
    ? latestEval.passCount / latestEval.totalCases
    : null;

  // Latest run per project, in parallel.
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
    <main className="mx-auto max-w-5xl space-y-8 p-6">
      {orgPaused && (
        <div
          className="rounded-md border border-red-200 bg-red-50 p-3 dark:border-red-800 dark:bg-red-900/20"
          role="status"
        >
          <div className="text-sm font-medium text-red-900 dark:text-red-200">
            Org-wide pause is active
          </div>
          <p className="text-xs text-red-800 dark:text-red-300">
            Paused {relativeTime(orgRes!.runsPausedAt!)}
            {orgRes!.runsPauseReason ? ` — ${orgRes!.runsPauseReason}` : ''}.
            No runs will fire on any project until resumed.
          </p>
        </div>
      )}

      <header className="flex items-baseline justify-between gap-3">
        <div className="flex items-baseline gap-3">
          <h1 className="text-2xl font-semibold">Today</h1>
          {orgPaused && <Chip kind="high">ORG PAUSED</Chip>}
          {evalPassRate != null && (
            <Link
              href={`/orgs/${slug}/evals`}
              className={
                'rounded-full px-2.5 py-0.5 text-xs font-medium ' +
                (evalPassRate >= 0.95
                  ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200'
                  : evalPassRate >= 0.8
                    ? 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200'
                    : 'bg-rose-100 text-rose-800 dark:bg-rose-900/40 dark:text-rose-200')
              }
              title={`Latest eval (${latestEval!.source}): ${latestEval!.passCount}/${latestEval!.totalCases} passing`}
            >
              evals · {(evalPassRate * 100).toFixed(0)}%
            </Link>
          )}
        </div>
        <div className="flex items-center gap-3">
          <PauseRunsControl
            paused={orgPaused}
            pauseAction={pauseOrgRunsAction}
            resumeAction={resumeOrgRunsAction}
            scopeLabel="all org runs"
          />
          <span className="text-sm text-zinc-500">{new Date().toDateString()}</span>
        </div>
      </header>

      {onboardingRes && !onboardingRes.complete && (
        <OrgSetupCard
          orgSlug={slug}
          totalSteps={onboardingRes.steps.length}
          pendingSteps={onboardingRes.steps.filter((s) => s.status === 'pending').length}
          demoProjectSlug={projects.find((p) => p.demo)?.slug ?? null}
        />
      )}

      {inbox.length > 0 && (
        <Card className="border-amber-200 bg-amber-50/50 dark:border-amber-700/40 dark:bg-amber-950/30">
          <div className="flex items-center justify-between gap-4">
            <div>
              <div className="font-medium">
                {inbox.length} pending approval{inbox.length === 1 ? '' : 's'}
              </div>
              <div className="text-sm text-zinc-500">
                Decisions block the next run. Resolve them in the inbox.
              </div>
            </div>
            <LinkButton href={`/orgs/${slug}/inbox`} variant="primary">
              Open inbox
            </LinkButton>
          </div>
        </Card>
      )}

      {spendCap?.projectionExceedsCap && spendCap.monthlySpendCapUsd !== null && (
        <Card className="border-amber-200 bg-amber-50/50 dark:border-amber-700/40 dark:bg-amber-950/30">
          <div className="flex items-center justify-between gap-4">
            <div>
              <div className="font-medium">
                Spend forecast: on track to exceed the monthly cap
              </div>
              <div className="text-sm text-zinc-500">
                Projected month-end ${spendCap.projectedMonthEndUsd.toFixed(0)} vs cap $
                {spendCap.monthlySpendCapUsd.toFixed(0)}.
                {spendCap.daysToCapExceedance != null && (
                  <> Cap likely hit around day {spendCap.daysToCapExceedance} at the current pace.</>
                )}
              </div>
            </div>
            <LinkButton href={`/orgs/${slug}/settings`} variant="secondary">
              Adjust cap
            </LinkButton>
          </div>
        </Card>
      )}

      <section>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-medium uppercase tracking-wide text-zinc-500">
            Projects {projects.length > 0 && <span className="ml-1 text-zinc-400">({projects.length})</span>}
          </h2>
          {projects.length > 0 && (
            <LinkButton href={`/orgs/${slug}/projects/new`}>New project</LinkButton>
          )}
        </div>
        {projects.length === 0 ? (
          <FirstRunEmptyState orgSlug={slug} />
        ) : (
          <ul className="grid grid-cols-1 gap-3 md:grid-cols-2">
            {projects.map((p, i) => {
              const run = latestRuns[i];
              const approvalCount = approvalsByProject.get(p.id) ?? 0;
              return (
                <li key={p.id}>
                  <Link
                    href={`/orgs/${slug}/projects/${p.slug}`}
                    className="block h-full"
                  >
                    <Card className="h-full transition-colors hover:border-accent">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <StatusDot status={run ? runStatusToDot(run.status) : 'idle'} />
                            <span className="font-medium">{p.name}</span>
                            <span className="text-sm text-zinc-500">/{p.slug}</span>
                            {p.demo && <Chip kind="medium">DEMO</Chip>}
                          </div>
                          {p.description && (
                            <p className="mt-1.5 line-clamp-2 text-sm text-zinc-600 dark:text-zinc-400">
                              {p.description}
                            </p>
                          )}
                          <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-zinc-500">
                            {run ? (
                              <>
                                <span>{run.status}</span>
                                <span>·</span>
                                <span>{relativeTime(run.startedAt ?? run.scheduledAt)}</span>
                              </>
                            ) : (
                              <span>No runs yet</span>
                            )}
                          </div>
                        </div>
                        {approvalCount > 0 && (
                          <Chip kind="medium">
                            {approvalCount} pending
                          </Chip>
                        )}
                      </div>
                    </Card>
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
            <h2 className="text-sm font-medium uppercase tracking-wide text-zinc-500">
              Recent activity
            </h2>
            <LinkButton href={`/orgs/${slug}/activity`}>View all</LinkButton>
          </div>
          <Card className="p-0">
            <ul className="divide-y divide-zinc-200 dark:divide-zinc-800">
              {activity.map((e) => {
                const projSlug = e.projectId ? projectIdToSlug.get(e.projectId) : undefined;
                const href = projSlug ? `/orgs/${slug}/projects/${projSlug}` : `/orgs/${slug}/activity`;
                return (
                  <li key={e.id}>
                    <Link
                      href={href}
                      className="flex items-center justify-between px-4 py-2.5 text-sm hover:bg-zinc-50 dark:hover:bg-zinc-900"
                    >
                      <div className="flex items-center gap-3">
                        <span className="font-mono text-xs text-zinc-500">{e.type}</span>
                        {projSlug && <span className="text-zinc-600 dark:text-zinc-400">{projSlug}</span>}
                      </div>
                      <span className="text-xs text-zinc-500">
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
