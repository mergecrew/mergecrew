import Link from 'next/link';
import { api } from '@/lib/api';
import { requireSession } from '@/lib/session';
import { Card, LinkButton, StatusDot, Chip } from '@/components/ui';
import { OnboardingChecklist } from '@/components/onboarding-checklist';
import { relativeTime, runStatusToDot } from '@/lib/format';

type Project = {
  id: string;
  slug: string;
  name: string;
  description?: string | null;
  connectedRepo?: { repoFullName: string; defaultBranch: string } | null;
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

  const [project, runsRes, changesetsRes, approvalsRes, schedule] = await Promise.all([
    api<Project>(`/v1/orgs/${slug}/projects/${projectSlug}`, { session }),
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
  ]);

  const runs = runsRes?.items ?? [];
  const changesets = changesetsRes?.items ?? [];
  const approvals = approvalsRes?.items ?? [];
  const latestRun = runs[0];

  const hasRepo = Boolean(project.connectedRepo);
  const hasDevTarget = (project.deployTargets ?? []).some((d) => d.kind === 'dev');
  const hasCompletedRun = runs.some((r) => r.status === 'done');
  const isPaused = !hasRepo || !hasDevTarget;

  return (
    <main className="mx-auto max-w-5xl space-y-8 p-6">
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


      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold">{project.name}</h1>
          {project.description && (
            <p className="mt-1.5 max-w-2xl text-sm text-zinc-600 dark:text-zinc-400">
              {project.description}
            </p>
          )}
          {project.connectedRepo && (
            <p className="mt-2 font-mono text-xs text-zinc-500">
              {project.connectedRepo.repoFullName} ·{' '}
              <span className="text-zinc-400">{project.connectedRepo.defaultBranch}</span>
            </p>
          )}
        </div>
        <div className="flex items-center gap-2">
          <LinkButton href={`/orgs/${slug}/projects/${projectSlug}/digest`}>
            Today's digest
          </LinkButton>
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
        </div>
      </header>

      <section className="grid grid-cols-1 gap-3 md:grid-cols-3">
        <Card>
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
        <Card>
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
        <Card>
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

function NavTile({ href, title, sub }: { href: string; title: string; sub: string }) {
  return (
    <Link href={href}>
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
  await api(`/v1/orgs/${slug}/projects/${projectSlug}/runs`, {
    method: 'POST',
    body: '{}',
    session,
  });
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
