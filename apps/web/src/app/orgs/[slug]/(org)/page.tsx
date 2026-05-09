import Link from 'next/link';
import { api } from '@/lib/api';
import { requireSession } from '@/lib/session';
import { Card, StatusDot, LinkButton, Chip } from '@/components/ui';
import { relativeTime, runStatusToDot } from '@/lib/format';

type Project = {
  id: string;
  slug: string;
  name: string;
  description?: string | null;
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

  const [projectsRes, inboxRes, activityRes] = await Promise.all([
    safe(() => api<{ items: Project[] }>(`/v1/orgs/${slug}/projects`, { session })),
    safe(() => api<{ items: ApprovalRequest[] }>(`/v1/orgs/${slug}/inbox`, { session })),
    safe(() => api<{ items: TimelineEvent[] }>(`/v1/orgs/${slug}/activity?limit=10`, { session })),
  ]);

  const projects = projectsRes?.items ?? [];
  const inbox = inboxRes?.items ?? [];
  const activity = activityRes?.items ?? [];

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

  return (
    <main className="mx-auto max-w-5xl space-y-8 p-6">
      <header className="flex items-baseline justify-between">
        <h1 className="text-2xl font-semibold">Today</h1>
        <span className="text-sm text-zinc-500">{new Date().toDateString()}</span>
      </header>

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
          <Card>
            <p className="text-zinc-500">No projects yet.</p>
            <div className="mt-3">
              <LinkButton href={`/orgs/${slug}/projects/new`} variant="primary">
                Connect your first GitHub repo
              </LinkButton>
            </div>
          </Card>
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
