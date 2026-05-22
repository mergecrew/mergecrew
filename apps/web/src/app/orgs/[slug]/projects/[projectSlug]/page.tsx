import Link from 'next/link';
import { redirect } from 'next/navigation';
import { Bot, Mail, Settings as SettingsIcon, Workflow } from 'lucide-react';
import { api, apiOr404 } from '@/lib/api';
import { requireSession } from '@/lib/session';
import { Card, LinkButton, StatusDot, Chip, PageHead, Tile } from '@/components/ui';
import { OnboardingChecklist } from '@/components/onboarding-checklist';
import { DemoProjectTour } from '@/components/demo-project-tour';
import { PromoteDigest, type DigestChangeset } from '@/components/promote-digest';
import type { PromoteRunSnapshot } from './settings/settings-actions';
import { relativeTime, runStatusToDot } from '@/lib/format';
import { revalidatePath } from 'next/cache';
import { PauseRunsControl } from '@/components/pause-runs-control';

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
  runsPausedAt?: string | null;
  runsPauseReason?: string | null;
  runsPausedByUserId?: string | null;
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

  const [project, runsRes, changesetsRes, approvalsRes, schedule, orgOnboardingRes, digestRes, orgRes] =
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
      // Org-pause state (#625). Surfaces the propagating banner on this
      // page when ops have hit the org-wide kill switch elsewhere.
      safe(() =>
        api<{ runsPausedAt?: string | null; runsPauseReason?: string | null }>(
          `/v1/orgs/${slug}`,
          { session },
        ),
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
  const runsPaused = Boolean(project.runsPausedAt);
  const orgPaused = Boolean(orgRes?.runsPausedAt);
  const isPaused = !hasRepo || !hasDevTarget || runsPaused || orgPaused;
  const isDemo = Boolean(project.demo);
  const orgWizardComplete = orgOnboardingRes?.complete ?? false;

  // Bind the server actions to this project's slug pair so the client
  // component doesn't need to know either.
  const pauseRunsActionBound = async (reason: string | null) => {
    'use server';
    const s = await requireSession();
    try {
      await api(`/v1/orgs/${slug}/projects/${projectSlug}/pause`, {
        method: 'POST',
        body: JSON.stringify({ reason }),
        session: s,
      });
      revalidatePath(`/orgs/${slug}/projects/${projectSlug}`);
      return { ok: true } as const;
    } catch (e: unknown) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) } as const;
    }
  };
  const resumeRunsActionBound = async () => {
    'use server';
    const s = await requireSession();
    try {
      await api(`/v1/orgs/${slug}/projects/${projectSlug}/resume`, {
        method: 'POST',
        body: '{}',
        session: s,
      });
      revalidatePath(`/orgs/${slug}/projects/${projectSlug}`);
      return { ok: true } as const;
    } catch (e: unknown) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) } as const;
    }
  };

  const openChangesetsCount = changesets.filter(
    (c) => !['merged', 'closed', 'rejected'].includes(c.status),
  ).length;

  return (
    <main className="mx-auto max-w-[1280px] px-4 py-5 sm:px-9 sm:py-7">
      {isDemo && <DemoProjectTour orgSlug={slug} />}
      <PageHead
        crumb={[
          { label: slug, href: `/orgs/${slug}` },
          { label: 'Projects', href: `/orgs/${slug}/projects` },
          { label: project.name },
        ]}
        title={project.name}
        meta={
          <div className="flex flex-wrap items-center gap-3">
            {isDemo && <Chip kind="medium">DEMO</Chip>}
            {runsPaused && <Chip kind="high">PAUSED</Chip>}
            {project.connectedRepo && (
              <span className="font-mono text-[12px] text-muted">
                {project.connectedRepo.repoFullName} ·{' '}
                <span className="text-muted-2">
                  {project.connectedRepo.basePrBranch?.trim() ||
                    project.connectedRepo.defaultBranch}
                </span>
              </span>
            )}
            {project.description && (
              <span className="text-[13px] text-ink-2">{project.description}</span>
            )}
          </div>
        }
        actions={
          <>
            <LinkButton
              href={`/orgs/${slug}/projects/${projectSlug}/digest`}
              variant="ghost"
              size="sm"
            >
              Today&apos;s digest
            </LinkButton>
            {!isDemo && !orgPaused && (
              <PauseRunsControl
                paused={runsPaused}
                pauseAction={pauseRunsActionBound}
                resumeAction={resumeRunsActionBound}
              />
            )}
            {!isDemo && (
              <RunNowForm
                orgSlug={slug}
                projectSlug={projectSlug}
                disabled={isPaused}
                disabledReason={
                  orgPaused
                    ? `Org-wide pause active${orgRes?.runsPauseReason ? `: ${orgRes.runsPauseReason}` : ''}`
                    : runsPaused
                    ? `Runs paused${project.runsPauseReason ? `: ${project.runsPauseReason}` : ''}`
                    : !hasRepo
                    ? 'Connect a GitHub repo to enable runs'
                    : 'Add a dev deploy target to enable runs'
                }
              />
            )}
          </>
        }
      />

      <div className="space-y-6">
        {isDemo && (
          <Card className="border-energy bg-energy-soft p-5" data-tour="setup-cta">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <div className="font-medium text-energy-deep">
                  This is a read-only demo project
                </div>
                <p className="text-[13px] text-ink-2">
                  Explore the seeded run, agent steps, and changeset. Set up your own project to
                  trigger real runs.
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-3">
                <Link
                  href={`/orgs/${slug}/projects/${projectSlug}?tour=replay`}
                  className="text-[13px] text-ink-2 underline-offset-[3px] hover:text-accent hover:underline"
                >
                  Replay tour
                </Link>
                <LinkButton href={`/orgs/${slug}/onboarding`} variant="energy">
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
            hasLifecycle={true}
            hasCompletedRun={hasCompletedRun}
            lastSkippedAt={schedule?.lastSkippedAt ?? null}
          />
        )}

        {orgPaused && (
          <div
            className="border border-energy bg-energy-soft p-4"
            role="status"
          >
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <div className="text-[13.5px] font-medium text-energy-deep">
                  Org-wide pause is active
                </div>
                <p className="mt-1 text-[12.5px] text-energy-deep/80">
                  Paused {relativeTime(orgRes!.runsPausedAt!)}
                  {orgRes!.runsPauseReason ? ` — ${orgRes!.runsPauseReason}` : ''}. Org pause
                  overrides per-project resume; lift it from the org dashboard.
                </p>
              </div>
              <LinkButton href={`/orgs/${slug}`} variant="ghost">
                Open org dashboard
              </LinkButton>
            </div>
          </div>
        )}

        {runsPaused && !orgPaused && (
          <div className="border border-energy bg-energy-soft p-4" role="status">
            <div className="text-[13.5px] font-medium text-energy-deep">
              Runs are paused for this project
            </div>
            <p className="mt-1 text-[12.5px] text-energy-deep/80">
              Paused {relativeTime(project.runsPausedAt!)}
              {project.runsPauseReason ? ` — ${project.runsPauseReason}` : ''}. Scheduled and
              manual runs will not fire until resumed.
            </p>
          </div>
        )}

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
          <Card className="p-5">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <div className="text-[14px] font-medium">Promotion not configured</div>
                <p className="mt-1 text-[12.5px] text-muted">
                  Pick how dev graduates to prod in settings before the daily promote ritual lights
                  up.
                </p>
              </div>
              <LinkButton
                href={`/orgs/${slug}/projects/${projectSlug}/settings`}
                variant="ghost"
                size="sm"
              >
                Configure promotion →
              </LinkButton>
            </div>
          </Card>
        )}

        <section className="grid grid-cols-1 gap-3 md:grid-cols-4">
          <Tile
            k="Latest run"
            v={latestRun ? latestRun.status : '—'}
            n={
              latestRun
                ? relativeTime(latestRun.startedAt ?? latestRun.scheduledAt)
                : 'No runs yet'
            }
          />
          <Tile
            k="Pending approvals"
            v={String(approvals.length)}
            n={approvals.length > 0 ? 'awaiting decision' : 'none'}
            energy={approvals.length > 0}
          />
          <Tile
            k="Open changesets"
            v={String(openChangesetsCount)}
            n={`${changesets.length} total`}
          />
          <Tile
            k="Status"
            v={isPaused ? 'paused' : 'active'}
            n={isPaused ? 'Resume in actions above' : 'Schedule armed'}
            accent={!isPaused}
            energy={isPaused}
          />
        </section>

        {approvals.length > 0 && (
          <section>
            <div className="mb-3 font-mono text-[11px] uppercase tracking-[0.1em] text-muted">
              Awaiting your decision
            </div>
            <Card>
              <ul className="m-0 list-none p-0">
                {approvals.map((a, i) => (
                  <li
                    key={a.id}
                    className={i < approvals.length - 1 ? 'border-b border-hair-2' : ''}
                  >
                    <div className="flex items-center justify-between gap-3 px-4 py-3">
                      <div>
                        <div className="text-[14px] font-medium">{a.kind ?? 'Approval'}</div>
                        <div className="font-mono text-[11.5px] text-muted">
                          {relativeTime(a.createdAt)}
                        </div>
                      </div>
                      <LinkButton href={`/orgs/${slug}/inbox`} variant="accent" size="sm">
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
              <div className="font-mono text-[11px] uppercase tracking-[0.1em] text-muted">
                Recent runs
              </div>
              <LinkButton
                href={`/orgs/${slug}/projects/${projectSlug}/runs`}
                variant="ghost"
                size="sm"
              >
                All runs
              </LinkButton>
            </div>
            <Card>
              {runs.length === 0 ? (
                <div className="p-4 text-[13px] text-muted">No runs yet.</div>
              ) : (
                <ul className="m-0 list-none p-0">
                  {runs.map((r, i) => (
                    <li
                      key={r.id}
                      className={i < runs.length - 1 ? 'border-b border-hair-2' : ''}
                    >
                      <Link
                        href={`/orgs/${slug}/projects/${projectSlug}/runs/${r.id}`}
                        className="flex items-center gap-3 px-4 py-3 text-[13px] text-ink no-underline hover:bg-paper-2"
                      >
                        <StatusDot status={runStatusToDot(r.status)} />
                        <div className="flex-1">
                          <div className="font-medium">{r.status}</div>
                          <div className="font-mono text-[11.5px] text-muted">
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
              <div className="font-mono text-[11px] uppercase tracking-[0.1em] text-muted">
                Recent changesets
              </div>
              <LinkButton
                href={`/orgs/${slug}/projects/${projectSlug}/changesets`}
                variant="ghost"
                size="sm"
              >
                All
              </LinkButton>
            </div>
            <Card>
              {changesets.length === 0 ? (
                <div className="p-4 text-[13px] text-muted">No changesets yet.</div>
              ) : (
                <ul className="m-0 list-none p-0">
                  {changesets.map((c, i) => (
                    <li
                      key={c.id}
                      className={i < changesets.length - 1 ? 'border-b border-hair-2' : ''}
                    >
                      <Link
                        href={`/orgs/${slug}/projects/${projectSlug}/changesets`}
                        className="flex items-center justify-between gap-3 px-4 py-3 text-[13px] text-ink no-underline hover:bg-paper-2"
                      >
                        <div className="min-w-0 flex-1">
                          <div className="truncate font-medium">
                            {c.title ?? c.id.slice(0, 8)}
                          </div>
                          <div className="font-mono text-[11.5px] text-muted">
                            {relativeTime(c.updatedAt)}
                          </div>
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
          <div className="mb-3 font-mono text-[11px] uppercase tracking-[0.1em] text-muted">
            Manage
          </div>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <NavTile
              href={`/orgs/${slug}/projects/${projectSlug}/lifecycle`}
              title="Lifecycle"
              sub="Workflow graph"
              Icon={Workflow}
              dataTour="manage-lifecycle"
            />
            <NavTile
              href={`/orgs/${slug}/projects/${projectSlug}/agents`}
              title="Agents"
              sub="Roster & models"
              Icon={Bot}
            />
            <NavTile
              href={`/orgs/${slug}/projects/${projectSlug}/digest`}
              title="Digest"
              sub="Today's summary"
              Icon={Mail}
            />
            <NavTile
              href={`/orgs/${slug}/projects/${projectSlug}/settings`}
              title="Settings"
              sub="Repo, deploys, gates"
              Icon={SettingsIcon}
            />
          </div>
        </section>
      </div>
    </main>
  );
}

function NavTile({
  href,
  title,
  sub,
  Icon,
  dataTour,
}: {
  href: string;
  title: string;
  sub: string;
  Icon?: typeof Workflow;
  dataTour?: string;
}) {
  return (
    <Link href={href} data-tour={dataTour} className="no-underline">
      <div className="h-full border border-hair bg-paper p-4 transition-colors hover:border-accent hover:bg-paper-2">
        {Icon && <Icon className="mb-3 h-5 w-5 text-accent" aria-hidden />}
        <div className="text-[14px] font-medium text-ink">{title}</div>
        <div className="mt-[2px] text-[12.5px] text-muted">{sub}</div>
      </div>
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
        className="inline-flex items-center justify-center gap-2 border border-accent bg-accent px-[14px] py-[9px] text-[13.5px] font-medium leading-none text-paper transition-[transform,background-color] duration-100 hover:-translate-y-[1px] hover:border-accent-deep hover:bg-accent-deep active:translate-y-0 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:translate-y-0"
        type="submit"
        disabled={disabled}
        title={disabled ? disabledReason : undefined}
        aria-disabled={disabled}
      >
        Run now
      </button>
      {disabled && disabledReason && (
        <p className="max-w-[16rem] text-right text-[11.5px] text-muted">
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
