import { revalidatePath } from 'next/cache';
import { api } from '@/lib/api';
import { requireSession } from '@/lib/session';
import { hasRole } from '@/lib/role';
import { Card } from '@/components/ui';
import { GeneralForm } from './general-form';
import { RepoForm } from './repo-form';
import { TrackerForm } from './tracker-form';
import { ScheduleForm } from './schedule-form';

export default async function ProjectSettings({
  params,
}: {
  params: Promise<{ slug: string; projectSlug: string }>;
}) {
  const { slug, projectSlug } = await params;
  const session = await requireSession();
  const project = await api<{
    name: string;
    slug: string;
    description: string | null;
    archivedAt: string | null;
    connectedRepo: {
      repoFullName: string;
      defaultBranch: string;
      installationId: string;
      repoId: string;
    } | null;
  }>(`/v1/orgs/${slug}/projects/${projectSlug}`, { session });

  const targets = await api<{ items: Array<{ id: string; kind: string; adapterId: string }> }>(
    `/v1/orgs/${slug}/projects/${projectSlug}/deploy-targets`,
    { session },
  );
  const tracker = await api<{
    id: string;
    adapterId: string;
    config: Record<string, unknown>;
    hasToken: boolean;
  } | null>(`/v1/orgs/${slug}/projects/${projectSlug}/tracker`, { session });
  const schedule = await api<{
    cron: string;
    timezone: string;
    enabled: boolean;
  } | null>(`/v1/orgs/${slug}/projects/${projectSlug}/schedule`, { session });
  const canEdit = await hasRole(slug, session, 'admin');

  return (
    <main className="mx-auto max-w-3xl space-y-6 p-6">
      <h1 className="text-xl font-semibold">Settings</h1>

      <Section
        title="General"
        description="Identity of the project. The description is shown to agents during runs and to humans on the project overview."
      >
        <GeneralForm
          slug={slug}
          projectSlug={projectSlug}
          initialName={project.name}
          initialDescription={project.description ?? ''}
          archived={Boolean(project.archivedAt)}
        />
      </Section>

      <Section
        title="Integrations"
        description="External systems Mergecrew connects to on this project's behalf."
      >
        <Subsection
          title="Repository"
          description="The Git repository the agents work against."
        >
          <RepoForm
            slug={slug}
            projectSlug={projectSlug}
            initial={project.connectedRepo ?? null}
          />
        </Subsection>

        <Subsection
          title="Issue tracker"
          description="Lets discovery agents read issues and Bug Triage create new ones. The token is encrypted at rest as the project secret TRACKER_TOKEN."
        >
          <TrackerForm
            slug={slug}
            projectSlug={projectSlug}
            initial={tracker ?? null}
          />
        </Subsection>
      </Section>

      <Section
        title="Deploy targets"
        description="Where the runner promotes changesets. dev / staging / prod each pick an adapter (GitHub Actions, Vercel, …)."
      >
        <ul className="space-y-2">
          {targets.items.map((t) => (
            <li
              key={t.id}
              className="flex items-baseline justify-between rounded border px-3 py-2 text-sm dark:border-zinc-800"
            >
              <span className="font-mono">{t.kind}</span>
              <span className="text-zinc-500">{t.adapterId}</span>
            </li>
          ))}
          {targets.items.length === 0 && (
            <li className="text-sm text-zinc-500">
              No targets configured. (Adapter-specific editor coming soon — set via API for now.)
            </li>
          )}
        </ul>
      </Section>

      <Section
        title="Schedule"
        description="When the project's daily run fires. Cron is evaluated in the configured timezone by the worker-cron tick."
      >
        <ScheduleForm
          initial={schedule}
          canEdit={canEdit}
          onSave={async (input) => {
            'use server';
            try {
              await api(`/v1/orgs/${slug}/projects/${projectSlug}/schedule`, {
                method: 'PATCH',
                body: JSON.stringify(input),
                session: await requireSession(),
              });
              revalidatePath(`/orgs/${slug}/projects/${projectSlug}/settings`);
              return { ok: true };
            } catch (e: any) {
              return { ok: false, error: String(e?.message ?? e) };
            }
          }}
        />
      </Section>
    </main>
  );
}

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <section>
      <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-500">{title}</h2>
      {description && (
        <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">{description}</p>
      )}
      <Card className="mt-2">{children}</Card>
    </section>
  );
}

function Subsection({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-2 border-t pt-4 first:border-t-0 first:pt-0 dark:border-zinc-800">
      <div>
        <h3 className="font-medium">{title}</h3>
        {description && <p className="text-xs text-zinc-500">{description}</p>}
      </div>
      {children}
    </div>
  );
}
