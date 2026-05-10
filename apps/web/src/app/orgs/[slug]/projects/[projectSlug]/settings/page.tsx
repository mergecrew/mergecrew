import { revalidatePath } from 'next/cache';
import { api } from '@/lib/api';
import { requireSession } from '@/lib/session';
import { hasRole } from '@/lib/role';
import { Card } from '@/components/ui';
import { GeneralForm } from './general-form';
import { RepoForm } from './repo-form';
import { TrackerForm } from './tracker-form';
import { ErrorTargetForm } from './error-target-form';
import { ScheduleForm } from './schedule-form';
import { InceptionForm } from './inception-form';
import { DeployTargetForm, type DeployTargetRow } from './deploy-target-form';
import { SmokeTestForm } from './smoke-test-form';

export default async function ProjectSettings({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string; projectSlug: string }>;
  searchParams: Promise<{ installation_id?: string; from?: string }>;
}) {
  const { slug, projectSlug } = await params;
  const sp = await searchParams;
  const installedInstallationId =
    sp.from === 'github_install' && sp.installation_id ? sp.installation_id : null;
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

  const targets = await api<{ items: DeployTargetRow[] }>(
    `/v1/orgs/${slug}/projects/${projectSlug}/deploy-targets`,
    { session },
  );
  const tracker = await api<{
    id: string;
    adapterId: string;
    config: Record<string, unknown>;
    hasToken: boolean;
  } | null>(`/v1/orgs/${slug}/projects/${projectSlug}/tracker`, { session });
  const errorTarget = await api<{
    id: string;
    adapterId: string;
    config: Record<string, unknown>;
    hasToken: boolean;
  } | null>(`/v1/orgs/${slug}/projects/${projectSlug}/error-target`, { session });
  const schedule = await api<{
    cron: string;
    timezone: string;
    enabled: boolean;
    skipDates: string[];
  } | null>(`/v1/orgs/${slug}/projects/${projectSlug}/schedule`, { session });
  // Project-level edits are operator-gated (see project.controller.ts).
  // Org-only operations like API keys / member invites stay admin-gated
  // and live under /orgs/<slug>/settings, not here.
  const canEdit = await hasRole(slug, session, 'operator');

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
            installedInstallationId={installedInstallationId}
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

        <Subsection
          title="Error tracker"
          description="Lets the Observation agent read recent crash and exception data. The token is encrypted at rest as the project secret ERROR_TRACKER_TOKEN."
        >
          <ErrorTargetForm
            slug={slug}
            projectSlug={projectSlug}
            initial={errorTarget ?? null}
          />
        </Subsection>
      </Section>

      <Section
        title="Deploy targets"
        description="Where the runner promotes changesets. dev / staging / prod each pick an adapter (GitHub Actions, Vercel, …). The dev target also drives the post-PR auto-deploy on each daily run."
      >
        <DeployTargetForm
          slug={slug}
          projectSlug={projectSlug}
          initial={targets.items}
        />
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

      <Section
        title="Project Inception"
        description="Detect the stack, scripts, and deploy workflows by scanning a fresh clone of the connected repo. Use the draft mergecrew.yaml as the starting point for the first daily run."
      >
        <InceptionForm
          slug={slug}
          projectSlug={projectSlug}
          hasRepo={Boolean(project.connectedRepo)}
        />
      </Section>

      <Section
        title="Onboarding smoke test"
        description="Confirms the round-trip: opens a no-op PR, dispatches the dev deploy, waits for completion, returns the URL. Run this once after configuring the repo + dev deploy target."
      >
        <SmokeTestForm
          slug={slug}
          projectSlug={projectSlug}
          ready={Boolean(project.connectedRepo) && targets.items.some((t) => t.kind === 'dev')}
          blockedReason={
            !project.connectedRepo
              ? 'Connect a repository first.'
              : !targets.items.some((t) => t.kind === 'dev')
                ? 'Configure a dev deploy target first.'
                : undefined
          }
        />
      </Section>

      <Section
        title="Auto-promote rules"
        description="Allowlist patterns that let qualifying changesets skip the manual approval gate (e.g. docs-only diffs, dep patch bumps)."
      >
        <a
          href={`/orgs/${slug}/projects/${projectSlug}/settings/auto-promote`}
          className="text-sm underline"
        >
          Manage rules →
        </a>
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
