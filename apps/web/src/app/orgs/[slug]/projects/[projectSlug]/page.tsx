import Link from 'next/link';
import { redirect } from 'next/navigation';
import { api, apiOr404 } from '@/lib/api';
import { requireSession } from '@/lib/session';
import { Card, LinkButton, StatusDot, Chip } from '@/components/ui';
import { OnboardingChecklist } from '@/components/onboarding-checklist';
import { DemoProjectTour } from '@/components/demo-project-tour';
import { PromoteDigest, type DigestChangeset } from '@/components/promote-digest';
import type { PromoteRunSnapshot } from './settings/settings-actions';
import { relativeTime, runStatusToDot } from '@/lib/format';

type Project = {
  id: string;
  slug: string;
  name: string;
  description?: string | null;
  demo?: boolean;
  connectedRepo?: {
    repoFullName: string;
    defaultBranch: string;
    basePrBranch?: string | null;
  } | null;
  deployTargets?: Array<{ kind: 'dev' | 'staging' | 'prod' }>;
};

type Run = {
  id: string;
  status: string;
  scheduledAt: string;
  startedAt?: string | null;
  completedAt?: string | null;
};

type Changeset = {
  id: string;
  title?: string | null;
  status: string;
  updatedAt: string;
  prUrl?: string | null;
};

type ApprovalRequest = {
  id: string;
  kind?: string | null;
  createdAt: string;
};

type Schedule = {
  id: string;
  cron: string;
  timezone: string;
  enabled: boolean;
  lastFiredAt?: string | null;
  lastSkippedAt?: string | null;
} | null;

export default async function ProjectOverview({
  params,
}: {
  params: Promise<{ slug: string; projectSlug: string }>;
}) {
  const { slug, projectSlug } = await params;
  const session = await requireSession();

  const [project, runsRes, changesetsRes, approvalsRes, schedule, orgOnboardingRes, digestRes] =
    await Promise.all([
      apiOr404<Project>(`/v1/orgs/${slug}/projects/${projectSlug}`, { session }),
      safe(() =>
        api<{ items: Run[] }>(
          `/v1/orgs/${slug}/projects/${projectSlug}/runs?limit=5`,
          { session },
        ),
      ),
      safe(() =>
        api<{ items: Changeset[] }>(
          `/v1/orgs/${slug}/projects/${projectSlug}/changesets?limit=5`,
          { session },
        ),
      ),
      safe(() =>
        api<{ items: ApprovalRequest[] }>(
          `/v1/orgs/${slug}/projects/${projectSlug}/approvals`,
          { session },
        ),
      ),
      safe(() =>
        api<Schedule>(`/v1/orgs/${slug}/projects/${projectSlug}/schedule`, { session }),
      ),
      // Org-level wizard state (#455). The per-project OnboardingChecklist
      // below only renders once the org wizard is complete — during FTE
      // the wizard owns the experience and the per-project banner would
      // just re-bait the redirect-to-settings path the wizard fixes.
      safe(() =>
        api<{ complete: boolean }>(`/v1/orgs/${slug}/onboarding`, { session }),
      ),
      // Promote digest (#472). Bundles the ready-to-promote changesets,
      // latest PromoteRun (for conflict surface), and the strategy kind
      // (so the deferred-state branch can short-circuit).
      safe(() =>
        api<{
          changesets: DigestChangeset[];
          latestRun: PromoteRunSnapshot | null;
          strategy: { kind: string } | null;
        }>(`/v1/orgs/${slug}/projects/${projectSlug}/promote-digest`, { session }),
      ),
    ]);

  const runs = runsRes?.items ?? [];
  const changesets = changesetsRes?.items ?? [];
  const approvals = approvalsRes?.items ?? [];
  const latestRun = runs[0];
  const digest = digestRes;
  const promotionConfigured = (digest?.strategy?.kind ?? 'deferred') !== 'deferred';

  const hasRepo = Boolean(project.connectedRepo);
  const hasDevTarget = (project.deployTargets ?? []).some((d) => d.kind === 'dev');
  const hasCompletedRun = runs.some((r) => r.status === 'done');
  const isPaused = !hasRepo || !hasDevTarget;
  const isDemo = Boolean(project.demo);
  const orgWizardComplete = orgOnboardingRes?.complete ?? false;

  return (
    <main className="mx-auto max-w-5xl space-y-8 p-6">
      {isDemo && <DemoProjectTour orgSlug={slug} />}
      {isDemo && (
        <Card
          className="border-amber-200 bg-amber-50/50 dark:border-amber-700/40 dark:bg-amber-950/30"
          data-tour="setup-cta"
        >
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <div className="font-medium">This is a read-only demo project</div>
              <p className="text-sm text-zinc-600 dark:text-zinc-300">
                Explore the seeded run, agent steps, and changeset. Set up your own project to trigger real runs.
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <Link
                href={`/orgs/${slug}/projects/${projectSlug}?tour=replay`}
                className="text-sm text-zinc-600 underline hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-200"
              >
                Replay tour
              </Link>
              <LinkButton href={`/orgs/${slug}/onboarding`} variant="primary">
                Set up your own project →
              </LinkButton>
            </div>
          </div>
        </Card>
      )}

      {!isDemo && orgWizardComplete && (
        <OnboardingChecklist
          orgSlug={slug}
          projectSlug={projectSlug}
          hasRepo={hasRepo}
          hasDevTarget={hasDevTarget}
          // Project creation seeds a v1 lifecycle and the GET endpoint
          // lazy-creates one too, so once the project exists this is
          // effectively always true (#252 closes the silent-skip path
          // for the theoretical "manually-deleted row" case).
          hasLifecycle={true}
          hasCompletedRun={hasCompletedRun}
          lastSkippedAt={schedule?.lastSkippedAt ?? null}
        />
      )}


      <header className="flex flex-wrap items-start justify-between gap-3" data-tour="project-header">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-semibold">{project.name}</h1>
            {isDemo && <Chip kind="medium">DEMO</Chip>}
          </div>
          {project.description && (
            <p className="mt-1.5 max-w-2xl text-sm text-zinc-600 dark:text-zinc-400">
              {project.description}
            </p>
          )}
          {project.connectedRepo && (
            <p className="mt-2 font-mono text-xs text-zinc-500">
              {project.connectedRepo.repoFullName} ·{' '}
              <span className="text-zinc-400">
                {project.connectedRepo.basePrBranch?.trim() ||
                  project.connectedRepo.defaultBranch}
              </span>
            </p>
          )}
        </div>
        <div className="flex items-center gap-2">
          <LinkButton href={`/orgs/${slug}/projects/${projectSlug}/digest`}>
            Today's digest
          </LinkButton>
          {!isDemo && (
            <RunNowForm
              orgSlug={slug}
              projectSlug={projectSlug}
              disabled={isPaused}
              disabledReason={
                !hasRepo
                  ? 'Connect a GitHub repo to enable runs'
                  : 'Add a dev deploy target to enable runs'
              }
            />
          )}
        </div>
      </header>

      {!isDemo && promotionConfigured && digest && (
        <PromoteDigest
          orgSlug={slug}
          projectSlug={projectSlug}
          changesets={digest.changesets}
          latestRun={digest.latestRun}
          strategyKind={digest.strategy?.kind ?? null}
          basePrBranch={
            project.connectedRepo?.basePrBranch?.trim() ||
            project.connectedRepo?.defaultBranch ||
            null
          }
        />
      )}

      {!isDemo && !promotionConfigured && (
        <Card className="border-zinc-200 dark:border-zinc-700">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div className="space-y-0.5">
              <div className="text-sm font-medium">Promotion not configured</div>
              <p className="text-xs text-zinc-500">
                Pick how dev graduates to prod in settings before the daily promote ritual lights up.
              </p>
            </div>
            <LinkButton
              href={`/orgs/${slug}/projects/${projectSlug}/settings`}
              variant="secondary"
            >
              Configure promotion →
            </LinkButton>
          </div>
        </Card>
      )}

      <section className="grid grid-cols-1 gap-3 md:grid-cols-3">
        <Card data-tour="latest-run">
          <div className="text-xs uppercase tracking-wide text-zinc-500">Latest run</div>
          {latestRun ? (
            <div className="mt-2 flex items-center gap-2">
              <StatusDot status={runStatusToDot(latestRun.status)} />
              <Link
                href={`/orgs/${slug}/projects/${projectSlug}/runs/${latestRun.id}`}
                className="font-medium hover:underline"
              >
                {latestRun.status}
              </Link>
              <span className="text-sm text-zinc-500">
                · {relativeTime(latestRun.startedAt ?? latestRun.scheduledAt)}
              </span>
            </div>
          ) : (
            <div className="mt-2 text-sm text-zinc-500">No runs yet</div>
          )}
        </Card>
        <Card data-tour="approvals">
          <div className="text-xs uppercase tracking-wide text-zinc-500">Pending approvals</div>
          <div className="mt-2 flex items-center gap-2">
            <span className="text-2xl font-semibold">{approvals.length}</span>
            {approvals.length > 0 && (
              <Link
                href={`/orgs/${slug}/inbox`}
                className="text-sm text-accent hover:underline"
              >
                review →
              </Link>
            )}
          </div>
        </Card>
        <Card data-tour="changesets">
          <div className="text-xs uppercase tracking-wide text-zinc-500">Open changesets</div>
          <div className="mt-2 flex items-center gap-2">
            <span className="text-2xl font-semibold">
              {changesets.filter((c) => !['merged', 'closed', 'rejected'].includes(c.status)).length}
            </span>
            {changesets.length > 0 && (
              <Link
                href={`/orgs/${slug}/projects/${projectSlug}/changesets`}
                className="text-sm text-accent hover:underline"
              >
                view →
              </Link>
            )}
          </div>
        </Card>
      </section>

      {approvals.length > 0 && (
        <section>
          <h2 className="mb-3 text-sm font-medium uppercase tracking-wide text-zinc-500">
            Awaiting your decision
          </h2>
          <Card className="p-0 border-amber-200 dark:border-amber-700/40">
            <ul className="divide-y divide-zinc-200 dark:divide-zinc-800">
              {approvals.map((a) => (
                <li key={a.id} className="px-4 py-3">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <div className="font-medium">{a.kind ?? 'Approval'}</div>
                      <div className="text-xs text-zinc-500">{relativeTime(a.createdAt)}</div>
                    </div>
                    <LinkButton href={`/orgs/${slug}/inbox`} variant="primary">
                      Review
                    </LinkButton>
                  </div>
                </li>
              ))}
            </ul>
          </Card>
        </section>
      )}

      <section className="grid grid-cols-1 gap-6 md:grid-cols-2">
        <div>
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-medium uppercase tracking-wide text-zinc-500">
              Recent runs
            </h2>
            <LinkButton href={`/orgs/${slug}/projects/${projectSlug}/timeline`}>
              Timeline
            </LinkButton>
          </div>
          <Card className="p-0">
            {runs.length === 0 ? (
              <div className="p-4 text-sm text-zinc-500">No runs yet.</div>
            ) : (
              <ul className="divide-y divide-zinc-200 dark:divide-zinc-800">
                {runs.map((r) => (
                  <li key={r.id}>
                    <Link
                      href={`/orgs/${slug}/projects/${projectSlug}/runs/${r.id}`}
                      className="flex items-center gap-3 px-4 py-2.5 text-sm hover:bg-zinc-50 dark:hover:bg-zinc-900"
                    >
                      <StatusDot status={runStatusToDot(r.status)} />
                      <div className="flex-1">
                        <div className="font-medium">{r.status}</div>
                        <div className="text-xs text-zinc-500">
                          {relativeTime(r.startedAt ?? r.scheduledAt)}
                        </div>
                      </div>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>

        <div>
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-medium uppercase tracking-wide text-zinc-500">
              Recent changesets
            </h2>
            <LinkButton href={`/orgs/${slug}/projects/${projectSlug}/changesets`}>
              All
            </LinkButton>
          </div>
          <Card className="p-0">
            {changesets.length === 0 ? (
              <div className="p-4 text-sm text-zinc-500">No changesets yet.</div>
            ) : (
              <ul className="divide-y divide-zinc-200 dark:divide-zinc-800">
                {changesets.map((c) => (
                  <li key={c.id}>
                    <Link
                      href={`/orgs/${slug}/projects/${projectSlug}/changesets`}
                      className="flex items-center justify-between gap-3 px-4 py-2.5 text-sm hover:bg-zinc-50 dark:hover:bg-zinc-900"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="truncate font-medium">{c.title ?? c.id.slice(0, 8)}</div>
                        <div className="text-xs text-zinc-500">{relativeTime(c.updatedAt)}</div>
                      </div>
                      <Chip kind={changesetKind(c.status)}>{c.status}</Chip>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      </section>

      <section>
        <h2 className="mb-3 text-sm font-medium uppercase tracking-wide text-zinc-500">
          Manage
        </h2>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <NavTile
            href={`/orgs/${slug}/projects/${projectSlug}/lifecycle`}
            title="Lifecycle"
            sub="Workflow graph"
            dataTour="manage-lifecycle"
          />
          <NavTile
            href={`/orgs/${slug}/projects/${projectSlug}/agents`}
            title="Agents"
            sub="Roster & models"
          />
          <NavTile
            href={`/orgs/${slug}/projects/${projectSlug}/digest`}
            title="Digest"
            sub="Today's summary"
          />
          <NavTile
            href={`/orgs/${slug}/projects/${projectSlug}/settings`}
            title="Settings"
            sub="Repo, deploys, gates"
          />
        </div>
      </section>
    </main>
  );
}

function NavTile({
  href,
  title,
  sub,
  dataTour,
}: {
  href: string;
  title: string;
  sub: string;
  dataTour?: string;
}) {
  return (
    <Link href={href} data-tour={dataTour}>
      <Card className="h-full transition-colors hover:border-accent">
        <div className="font-medium">{title}</div>
        <div className="text-sm text-zinc-500">{sub}</div>
      </Card>
    </Link>
  );
}

function changesetKind(status: string): 'low' | 'medium' | 'high' | 'neutral' {
  if (status === 'merged' || status === 'approved' || status === 'promoted') return 'low';
  if (status === 'rejected' || status === 'failed' || status === 'closed') return 'high';
  if (status === 'pending' || status === 'open' || status === 'awaiting_review') return 'medium';
  return 'neutral';
}

async function runNowAction(formData: FormData) {
  'use server';
  const slug = String(formData.get('orgSlug') ?? '');
  const projectSlug = String(formData.get('projectSlug') ?? '');
  const session = await requireSession();
  const result = await api<{ runId?: string }>(`/v1/orgs/${slug}/projects/${projectSlug}/runs`, {
    method: 'POST',
    body: '{}',
    session,
  });
  // Server-side redirect to the live run-detail page so the operator
  // sees the SSE timeline streaming immediately (#407, V2.aj). The
  // API pre-creates the DailyRun row and returns its id, so the
  // target URL is valid before the orchestrator picks the run up.
  if (result?.runId) {
    redirect(`/orgs/${slug}/projects/${projectSlug}/runs/${result.runId}`);
  }
}

function RunNowForm({
  orgSlug,
  projectSlug,
  disabled = false,
  disabledReason,
}: {
  orgSlug: string;
  projectSlug: string;
  disabled?: boolean;
  disabledReason?: string;
}) {
  return (
    <form action={runNowAction} className="flex flex-col items-end gap-1">
      <input type="hidden" name="orgSlug" value={orgSlug} />
      <input type="hidden" name="projectSlug" value={projectSlug} />
      <button
        className="inline-flex items-center justify-center rounded-md bg-accent px-3 py-1.5 text-sm text-accent-fg transition-colors hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:opacity-40"
        type="submit"
        disabled={disabled}
        title={disabled ? disabledReason : undefined}
        aria-disabled={disabled}
      >
        Run now
      </button>
      {disabled && disabledReason && (
        <p className="max-w-[16rem] text-right text-xs text-zinc-500 dark:text-zinc-400">
          {disabledReason}
        </p>
      )}
    </form>
  );
}

async function safe<T>(fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch {
    return null;
  }
}
