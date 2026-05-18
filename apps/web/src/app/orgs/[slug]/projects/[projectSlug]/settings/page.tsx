import { revalidatePath } from 'next/cache';
import { api, apiOr404 } from '@/lib/api';
import { requireSession } from '@/lib/session';
import { hasRole } from '@/lib/role';
import { Card, LinkButton } from '@/components/ui';
import { TabStrip, type TabDef } from '@/components/tabs';
import { GeneralForm } from './general-form';
import { RepoForm } from './repo-form';
import { TrackerForm } from './tracker-form';
import { ErrorTargetForm } from './error-target-form';
import { ScheduleForm } from './schedule-form';
import { InceptionForm } from './inception-form';
import { DeployTargetForm, type DeployTargetRow } from './deploy-target-form';
import {
  PromotionStrategyForm,
  type PromotionStrategy,
} from './promotion-strategy-form';
import { SmokeTestForm } from './smoke-test-form';
import { DryRunForm } from './dry-run-form';
import { BlastRadiusForm } from './blast-radius-form';
import { RiskScoreForm } from './risk-score-form';
import { RecentRollbacks } from './recent-rollbacks';
import { GraphProfileForm } from './graph-profile-form';

const TABS: TabDef[] = [
  { id: 'setup', label: 'Setup' },
  { id: 'pipeline', label: 'Pipeline' },
  { id: 'guardrails', label: 'Guardrails' },
  { id: 'tools', label: 'Tools' },
];

export default async function ProjectSettings({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string; projectSlug: string }>;
  searchParams: Promise<{ installation_id?: string; from?: string; tab?: string }>;
}) {
  const { slug, projectSlug } = await params;
  const sp = await searchParams;
  const installedInstallationId =
    sp.from === 'github_install' && sp.installation_id ? sp.installation_id : null;
  const activeTab = TABS.some((t) => t.id === sp.tab) ? (sp.tab as string) : 'setup';
  const session = await requireSession();
  const project = await apiOr404<{
    name: string;
    slug: string;
    description: string | null;
    archivedAt: string | null;
    demo: boolean;
    dryRun: boolean;
    maxFilesChanged: number;
    maxLinesChanged: number;
    deniedPaths: string[] | null;
    autoMergeThreshold: number;
    sensitivePaths: string[] | null;
    graphProfile: 'fast' | 'careful' | 'custom';
    graphYaml: string | null;
    connectedRepo: {
      repoFullName: string;
      defaultBranch: string;
      installationId: string;
      repoId: string;
      basePrBranch: string | null;
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
  // Recent rollbacks for the Guardrails section (#289). Best-effort —
  // a fetch failure leaves the widget empty rather than blocking the
  // whole settings page.
  const promotionStrategy = await api<PromotionStrategy | null>(
    `/v1/orgs/${slug}/projects/${projectSlug}/promotion-strategy`,
    { session },
  ).catch(() => null);
  const recentRollbacks = await api<{
    items: Array<{
      id: string;
      title: string;
      revertPrNumber: number | null;
      revertPrUrl: string | null;
      updatedAt: string;
    }>;
  }>(`/v1/orgs/${slug}/projects/${projectSlug}/recent-rollbacks?limit=3`, { session }).catch(
    () => ({ items: [] }),
  );
  // Project-level edits are operator-gated (see project.controller.ts).
  // Org-only operations like API keys / member invites stay admin-gated
  // and live under /orgs/<slug>/settings, not here.
  const canEdit = await hasRole(slug, session, 'operator');

  // Fetch the list of repos the operator's GitHub App installation can
  // access so the form renders a dropdown instead of free-text input.
  // Two paths feed the installation id:
  //   - Fresh install: `installation_id` query param from the callback
  //     (#184, the original V1.1 wiring).
  //   - Already connected: re-use the saved row's installationId so an
  //     operator returning to settings later still gets the dropdown
  //     (#267 — closes the "only on first install" gap).
  // Best-effort: if the endpoint fails (no GITHUB_APP_* env, transient
  // error), the UI falls back to free-text inputs.
  let availableRepos: Array<{
    repoId: string;
    repoFullName: string;
    defaultBranch: string;
    private: boolean;
  }> = [];
  const lookupInstallationId =
    installedInstallationId ?? project.connectedRepo?.installationId ?? null;
  if (lookupInstallationId && canEdit) {
    try {
      const r = await api<{ items: typeof availableRepos }>(
        `/v1/orgs/${slug}/projects/${projectSlug}/installation-repos/${encodeURIComponent(lookupInstallationId)}`,
        { session },
      );
      availableRepos = r.items;
    } catch {
      // Swallow — RepoForm degrades to free-text inputs.
    }
  }

  if (project.demo) {
    return (
      <main className="mx-auto max-w-3xl space-y-6 p-6">
        <h1 className="text-xl font-semibold">Settings</h1>
        <Card className="border-amber-200 bg-amber-50/50 dark:border-amber-700/40 dark:bg-amber-950/30">
          <div className="space-y-3">
            <div className="font-medium">This is a read-only demo project</div>
            <p className="text-sm text-zinc-600 dark:text-zinc-300">
              Demo settings can&apos;t be edited. Set up your own project to wire a repo, deploy target, schedule, and the rest.
            </p>
            <LinkButton href={`/orgs/${slug}/onboarding`} variant="primary">
              Set up your own project →
            </LinkButton>
          </div>
        </Card>
      </main>
    );
  }

  const settingsPath = `/orgs/${slug}/projects/${projectSlug}/settings`;

  return (
    <main className="mx-auto max-w-3xl space-y-6 p-6">
      <h1 className="text-xl font-semibold">Settings</h1>
      <TabStrip tabs={TABS} active={activeTab} pathname={settingsPath} />

      {activeTab === 'setup' && (
        <>
          {/* Pointer to org-level LLM (#498). Operators landed here
              looking for model + API key config; without this they
              couldn't tell providers / profiles are org-scoped and
              live on a different page. */}
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            Looking for model + API key config? LLM providers and profiles
            are org-shared.{' '}
            <a
              href={`/orgs/${slug}/settings#llm`}
              className="text-accent underline decoration-dotted"
            >
              Manage at the org level →
            </a>
          </p>

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
                availableRepos={availableRepos}
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
        </>
      )}

      {activeTab === 'pipeline' && (
        <>
          <Section
            title="Deploy targets"
            description="Where the runner promotes changesets. Each row picks an adapter (GitHub Actions, Vercel, …). The dev target drives the post-PR auto-deploy on each daily run; the prod target is the promotion destination."
          >
            <DeployTargetForm
              slug={slug}
              projectSlug={projectSlug}
              initial={targets.items}
            />
          </Section>

          <Section
            title="Promotion strategy"
            description="How the human-approved subset of dev changesets graduates to prod. mergecrew cherry-picks approved changes onto a release ref; this picker controls what triggers your CI's prod deploy from that ref."
          >
            <PromotionStrategyForm
              slug={slug}
              projectSlug={projectSlug}
              orgSlug={slug}
              initial={promotionStrategy}
              defaultReleaseBranch={
                project.connectedRepo?.basePrBranch?.trim() ||
                project.connectedRepo?.defaultBranch
              }
            />
          </Section>

          <Section
            title="Agent graph"
            description="How runs dispatch agents. fast = single-agent V1 behavior; careful = planner → coder → reviewer with loop-back; custom = your own YAML."
          >
            <GraphProfileForm
              slug={slug}
              projectSlug={projectSlug}
              initialProfile={project.graphProfile}
              initialYaml={project.graphYaml}
              canEdit={canEdit}
            />
          </Section>
        </>
      )}

      {activeTab === 'guardrails' && (
        <Section
          title="Guardrails"
          description="Safety controls that constrain what the agent loop is allowed to do on this project."
        >
          <div className="space-y-6">
            <DryRunForm
              slug={slug}
              projectSlug={projectSlug}
              initialDryRun={project.dryRun}
              canEdit={canEdit}
            />
            <div className="border-t pt-4 dark:border-zinc-800">
              <h3 className="text-sm font-medium">Blast-radius limits</h3>
              <div className="mt-2">
                <BlastRadiusForm
                  slug={slug}
                  projectSlug={projectSlug}
                  initialMaxFiles={project.maxFilesChanged}
                  initialMaxLines={project.maxLinesChanged}
                  initialDeniedPaths={project.deniedPaths ?? []}
                  canEdit={canEdit}
                />
              </div>
            </div>
            <div className="border-t pt-4 dark:border-zinc-800">
              <h3 className="text-sm font-medium">Risk-score gate</h3>
              <div className="mt-2">
                <RiskScoreForm
                  slug={slug}
                  projectSlug={projectSlug}
                  initialThreshold={project.autoMergeThreshold}
                  initialSensitivePaths={project.sensitivePaths ?? []}
                  canEdit={canEdit}
                />
              </div>
            </div>
            <div className="border-t pt-4 dark:border-zinc-800">
              <h3 className="text-sm font-medium">Auto-promote rules</h3>
              <p className="mt-1 text-xs text-zinc-500">
                Allowlist patterns that let qualifying changesets skip the manual approval gate
                (e.g. docs-only diffs, dep patch bumps).
              </p>
              <a
                href={`/orgs/${slug}/projects/${projectSlug}/settings/auto-promote`}
                className="mt-2 inline-block text-sm underline"
              >
                Manage rules →
              </a>
            </div>
            <div className="border-t pt-4 dark:border-zinc-800">
              <div className="flex items-baseline justify-between">
                <h3 className="text-sm font-medium">Recent rollbacks</h3>
                <a
                  href="https://github.com/mergecrew/mergecrew/blob/main/docs/03-infrastructure/12-rollback.md"
                  target="_blank"
                  rel="noreferrer"
                  className="text-xs text-zinc-500 underline decoration-dotted hover:text-zinc-700 dark:hover:text-zinc-300"
                >
                  Rollback guide →
                </a>
              </div>
              <p className="mt-1 mb-2 text-xs text-zinc-500">
                Last three merged changesets undone via the one-click rollback button. Each row
                links to the changeset and its revert PR.
              </p>
              <RecentRollbacks
                slug={slug}
                projectSlug={projectSlug}
                rollbacks={recentRollbacks.items}
              />
            </div>
          </div>
        </Section>
      )}

      {activeTab === 'tools' && (
        <>
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
        </>
      )}
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
  // Subsections inside the Integrations card stack vertically with a
  // divider between each. The forms below (RepoForm, TrackerForm,
  // ErrorTargetForm) end with a save button at the bottom with no
  // trailing margin, so the divider previously sat flush against the
  // button (#499). pt-6 + pb-6 gives the divider equal breathing room
  // on both sides; the first/last carve-outs keep the Card padding
  // from doubling up at the edges.
  return (
    <div className="space-y-2 border-t pb-6 pt-6 first:border-t-0 first:pt-0 last:pb-0 dark:border-zinc-800">
      <div>
        <h3 className="font-medium">{title}</h3>
        {description && <p className="text-xs text-zinc-500">{description}</p>}
      </div>
      {children}
    </div>
  );
}
