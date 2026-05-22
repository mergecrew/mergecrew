import { revalidatePath } from 'next/cache';
import { api, apiOr404 } from '@/lib/api';
import { requireSession } from '@/lib/session';
import { hasRole } from '@/lib/role';
import { Card, LinkButton, PageHead } from '@/components/ui';
import { SettingsLayout, Section } from '@/components/shell/settings-layout';
import { GeneralForm } from './general-form';
import { RepoForm } from './repo-form';
import { TrackerForm } from './tracker-form';
import { ErrorTargetForm } from './error-target-form';
import { ScheduleForm } from './schedule-form';
import { InceptionForm } from './inception-form';
import { DeployTargetForm, type DeployTargetRow } from './deploy-target-form';
import { PromotionStrategyForm, type PromotionStrategy } from './promotion-strategy-form';
import { SmokeTestForm } from './smoke-test-form';
import { DryRunForm } from './dry-run-form';
import { BlastRadiusForm } from './blast-radius-form';
import { RiskScoreForm } from './risk-score-form';
import { RecentRollbacks } from './recent-rollbacks';
import { GraphProfileForm } from './graph-profile-form';
import { RunnerSummary } from './runner-summary';
import { EgressAllowlistForm } from './egress-allowlist-form';
import { SlosForm } from './slos-form';
import type { SloListResponse } from './slos-actions';

const NAV = [
  {
    label: 'Setup',
    items: [
      { id: 'general', label: 'General' },
      { id: 'repository', label: 'Repository' },
      { id: 'tracker', label: 'Issue tracker' },
      { id: 'error-tracker', label: 'Error tracker' },
      { id: 'schedule', label: 'Schedule' },
    ],
  },
  {
    label: 'Pipeline',
    items: [
      { id: 'deploy-targets', label: 'Deploy targets' },
      { id: 'promotion', label: 'Promotion strategy' },
      { id: 'graph', label: 'Agent graph' },
    ],
  },
  {
    label: 'Runner',
    items: [
      { id: 'egress', label: 'Egress allowlist' },
      { id: 'runner', label: 'Runner sandbox' },
    ],
  },
  {
    label: 'Guardrails',
    items: [
      { id: 'dry-run', label: 'Dry run' },
      { id: 'blast-radius', label: 'Blast radius' },
      { id: 'risk-score', label: 'Risk score' },
      { id: 'auto-promote', label: 'Auto-promote' },
      { id: 'rollbacks', label: 'Recent rollbacks' },
    ],
  },
  {
    label: 'Tools',
    items: [
      { id: 'inception', label: 'Project inception' },
      { id: 'smoke', label: 'Onboarding smoke test' },
    ],
  },
  {
    label: 'Operations',
    items: [{ id: 'slos', label: 'SLOs' }],
  },
  {
    label: 'Audit',
    items: [{ id: 'audit-log', label: 'Audit log' }],
  },
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
  const session = await requireSession();
  const project = await apiOr404<{
    id: string;
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
    egressAllowlist: string[] | null;
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
  const canEdit = await hasRole(slug, session, 'operator');
  const isAdmin = await hasRole(slug, session, 'admin');

  // Audit log is admin-gated on the API side; skip the fetch when the
  // viewer isn't an admin so we don't surface a 403 to operators.
  const auditLog = isAdmin
    ? await api<{
        items: Array<{
          id: string;
          action: string;
          occurredAt: string;
          target: any;
          metadata: any;
          actorUserId: string | null;
          actor: { id: string; email: string; name: string | null } | null;
        }>;
      }>(
        `/v1/orgs/${slug}/audit-log?limit=50&projectId=${encodeURIComponent(project.id)}`,
        { session },
      ).catch(() => ({ items: [] }))
    : { items: [] };

  const slos = await api<SloListResponse>(
    `/v1/orgs/${slug}/projects/${projectSlug}/slos`,
    { session },
  ).catch(() => ({ items: [] }) as SloListResponse);

  const lifecycleResp = await api<{ parsed?: { runner?: Record<string, unknown> } } | null>(
    `/v1/orgs/${slug}/projects/${projectSlug}/lifecycle`,
    { session },
  ).catch(() => null);
  const runnerCfg = (lifecycleResp?.parsed?.runner ?? null) as Parameters<
    typeof RunnerSummary
  >[0]['runner'];

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
      /* form falls back to free-text */
    }
  }

  if (project.demo) {
    return (
      <main className="mx-auto max-w-[1080px] px-4 py-5 sm:px-9 sm:py-7">
        <PageHead
          crumb={[
            { label: slug, href: `/orgs/${slug}` },
            { label: projectSlug, href: `/orgs/${slug}/projects/${projectSlug}` },
            { label: 'Settings' },
          ]}
          title="Settings"
        />
        <Card className="border-energy bg-energy-soft p-5">
          <div className="space-y-3">
            <div className="font-medium text-energy-deep">This is a read-only demo project</div>
            <p className="text-[13.5px] text-ink-2">
              Demo settings can&apos;t be edited. Set up your own project to wire a repo, deploy
              target, schedule, and the rest.
            </p>
            <LinkButton href={`/orgs/${slug}/onboarding`} variant="energy">
              Set up your own project →
            </LinkButton>
          </div>
        </Card>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-[1280px] px-4 py-5 sm:px-9 sm:py-7">
      <PageHead
        crumb={[
          { label: slug, href: `/orgs/${slug}` },
          { label: projectSlug, href: `/orgs/${slug}/projects/${projectSlug}` },
          { label: 'Settings' },
        ]}
        title="Settings"
        meta={
          <span className="font-mono text-[12.5px] text-muted">
            15 sections · {canEdit ? 'editable' : 'view-only'}. Looking for LLM providers?{' '}
            <a
              href={`/orgs/${slug}/settings#llm`}
              className="text-accent underline-offset-[3px] hover:underline"
            >
              Org-level →
            </a>
          </span>
        }
      />

      <SettingsLayout nav={NAV}>
        <Section
          id="general"
          anchor="01 · GENERAL"
          title="General"
          desc="Identity of the project. The description is shown to agents during runs and to humans on the project overview."
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
          id="repository"
          anchor="02 · REPOSITORY"
          title="Repository"
          desc="The Git repository the agents work against."
        >
          <RepoForm
            slug={slug}
            projectSlug={projectSlug}
            initial={project.connectedRepo ?? null}
            installedInstallationId={installedInstallationId}
            availableRepos={availableRepos}
          />
        </Section>

        <Section
          id="tracker"
          anchor="03 · ISSUE TRACKER"
          title="Issue tracker"
          desc="Lets discovery agents read issues and Bug Triage create new ones. The token is encrypted at rest as the project secret TRACKER_TOKEN."
        >
          <TrackerForm slug={slug} projectSlug={projectSlug} initial={tracker ?? null} />
        </Section>

        <Section
          id="error-tracker"
          anchor="04 · ERROR TRACKER"
          title="Error tracker"
          desc="Lets the Observation agent read recent crash and exception data. The token is encrypted at rest as the project secret ERROR_TRACKER_TOKEN."
        >
          <ErrorTargetForm slug={slug} projectSlug={projectSlug} initial={errorTarget ?? null} />
        </Section>

        <Section
          id="schedule"
          anchor="05 · SCHEDULE"
          title="Schedule"
          desc="When the project's daily run fires. Cron is evaluated in the configured timezone by the worker-cron tick."
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
          id="deploy-targets"
          anchor="06 · DEPLOY TARGETS"
          title="Deploy targets"
          desc="Where the runner promotes changesets. Each row picks an adapter (GitHub Actions, Vercel, …). The dev target drives the post-PR auto-deploy on each daily run; the prod target is the promotion destination."
        >
          <DeployTargetForm slug={slug} projectSlug={projectSlug} initial={targets.items} />
        </Section>

        <Section
          id="promotion"
          anchor="07 · PROMOTION"
          title="Promotion strategy"
          desc="How the human-approved subset of dev changesets graduates to prod. mergecrew cherry-picks approved changes onto a release ref; this picker controls what triggers your CI's prod deploy from that ref."
        >
          <PromotionStrategyForm
            slug={slug}
            projectSlug={projectSlug}
            orgSlug={slug}
            initial={promotionStrategy}
            defaultReleaseBranch={
              project.connectedRepo?.basePrBranch?.trim() || project.connectedRepo?.defaultBranch
            }
          />
        </Section>

        <Section
          id="graph"
          anchor="08 · AGENT GRAPH"
          title="Agent graph"
          desc="How runs dispatch agents. fast = single-agent V1 behavior; careful = planner → coder → reviewer with loop-back; custom = your own YAML."
        >
          <GraphProfileForm
            slug={slug}
            projectSlug={projectSlug}
            initialProfile={project.graphProfile}
            initialYaml={project.graphYaml}
            canEdit={canEdit}
          />
        </Section>

        <Section
          id="egress"
          anchor="09 · EGRESS"
          title="Egress allowlist"
          desc="Per-project hostname allowlist. Enforced on every HTTP-bound skill, and (when the supervisor runs a docker / kubernetes / fargate / e2b sandbox driver) on the per-run network namespace + DNS resolver. Blocked attempts surface on each run's Network section."
        >
          <EgressAllowlistForm
            slug={slug}
            projectSlug={projectSlug}
            initial={project.egressAllowlist}
            canEdit={canEdit}
          />
        </Section>

        <Section
          id="runner"
          anchor="10 · RUNNER"
          title="Runner sandbox"
          desc="Where the build runs: which image, what resources, what persists between runs. Read from your lifecycle YAML (mergecrew.yaml); edit on the Lifecycle page."
        >
          <RunnerSummary orgSlug={slug} projectSlug={projectSlug} runner={runnerCfg} />
        </Section>

        <Section
          id="dry-run"
          anchor="11 · DRY RUN"
          title="Dry run"
          desc="When on, the runner produces diffs + changeset rows but skips git push, PR creation, and deploys — useful as a tripwire while wiring new tooling."
        >
          <DryRunForm
            slug={slug}
            projectSlug={projectSlug}
            initialDryRun={project.dryRun}
            canEdit={canEdit}
          />
        </Section>

        <Section
          id="blast-radius"
          anchor="12 · BLAST RADIUS"
          title="Blast radius"
          desc="Hard caps on files / lines per changeset, plus a deny-list of paths the agents cannot touch."
        >
          <BlastRadiusForm
            slug={slug}
            projectSlug={projectSlug}
            initialMaxFiles={project.maxFilesChanged}
            initialMaxLines={project.maxLinesChanged}
            initialDeniedPaths={project.deniedPaths ?? []}
            canEdit={canEdit}
          />
        </Section>

        <Section
          id="risk-score"
          anchor="13 · RISK SCORE"
          title="Risk score"
          desc="A blended risk number per changeset. Above the threshold, the changeset is blocked from auto-merge. Sensitive paths skew the score upward."
        >
          <RiskScoreForm
            slug={slug}
            projectSlug={projectSlug}
            initialThreshold={project.autoMergeThreshold}
            initialSensitivePaths={project.sensitivePaths ?? []}
            canEdit={canEdit}
          />
        </Section>

        <Section
          id="auto-promote"
          anchor="14 · AUTO-PROMOTE"
          title="Auto-promote rules"
          desc="Allowlist patterns that let qualifying changesets skip the manual approval gate (e.g. docs-only diffs, dep patch bumps)."
        >
          <a
            href={`/orgs/${slug}/projects/${projectSlug}/settings/auto-promote`}
            className="inline-block text-[13.5px] text-accent underline-offset-[3px] hover:underline"
          >
            Manage rules →
          </a>
        </Section>

        <Section
          id="rollbacks"
          anchor="15 · ROLLBACKS"
          title="Recent rollbacks"
          desc="Last three merged changesets undone via the one-click rollback button. Each row links to the changeset and its revert PR."
        >
          <RecentRollbacks
            slug={slug}
            projectSlug={projectSlug}
            rollbacks={recentRollbacks.items}
          />
        </Section>

        <Section
          id="inception"
          anchor="16 · INCEPTION"
          title="Project inception"
          desc="Detect the stack, scripts, and deploy workflows by scanning a fresh clone of the connected repo. Use the draft mergecrew.yaml as the starting point for the first daily run."
        >
          <InceptionForm
            slug={slug}
            projectSlug={projectSlug}
            hasRepo={Boolean(project.connectedRepo)}
          />
        </Section>

        <Section
          id="smoke"
          anchor="17 · SMOKE TEST"
          title="Onboarding smoke test"
          desc="Confirms the round-trip: opens a no-op PR, dispatches the dev deploy, waits for completion, returns the URL. Run this once after configuring the repo + dev deploy target."
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
          id="slos"
          anchor="18 · OPERATIONS"
          title="SLOs"
          desc="Service-level objectives evaluated every 5 minutes against the metrics rollups. Breaches and recoveries appear on the project activity stream and are routed to your alert channels."
        >
          <SlosForm
            slug={slug}
            projectSlug={projectSlug}
            initial={slos}
            canEdit={canEdit}
          />
        </Section>

        <Section
          id="audit-log"
          anchor="19 · AUDIT"
          title="Audit log"
          desc={
            isAdmin ? (
              <>
                Immutable record of admin actions touching this project. Org-wide events live
                under{' '}
                <a
                  href={`/orgs/${slug}/settings#audit-log`}
                  className="text-accent underline-offset-[3px] hover:underline"
                >
                  Org settings → Audit log
                </a>
                .{' '}
                <a
                  href={`/api/v1/orgs/${slug}/audit-log?format=csv&projectId=${encodeURIComponent(project.id)}`}
                  className="text-accent underline-offset-[3px] hover:underline"
                >
                  Export CSV →
                </a>
              </>
            ) : (
              'Audit log access is admin-only on this org. Ask an admin to surface specific events.'
            )
          }
        >
          <Card>
            {!isAdmin ? (
              <div className="p-5 text-[13px] text-muted">
                You need the <code className="font-mono text-[12px] text-ink">admin</code> role
                to view this section.
              </div>
            ) : auditLog.items.length === 0 ? (
              <div className="p-5 text-[13px] text-muted">
                No project-scoped audit events yet. Any admin action touching this project
                (pause / resume, member changes, settings) will appear here.
              </div>
            ) : (
              <ul className="m-0 list-none p-0">
                {auditLog.items.map((e, i) => {
                  const actorLabel =
                    e.actor?.name?.trim() || e.actor?.email || e.actorUserId || 'system';
                  return (
                    <li
                      key={e.id}
                      className={
                        i < auditLog.items.length - 1 ? 'border-b border-hair-2' : ''
                      }
                    >
                      <div className="grid grid-cols-1 items-baseline gap-2 px-5 py-3 text-[13px] md:grid-cols-[170px_220px_1fr] md:gap-4">
                        <span
                          className="font-mono text-[11.5px] text-muted"
                          title={new Date(e.occurredAt).toLocaleString()}
                        >
                          {new Date(e.occurredAt).toLocaleString()}
                        </span>
                        <span className="bg-accent-tint px-[8px] py-[2px] font-mono text-[10.5px] uppercase tracking-[0.06em] text-accent-deep">
                          {e.action}
                        </span>
                        <span className="min-w-0 truncate text-ink-2">
                          <b className="text-ink">{actorLabel}</b>
                        </span>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>
        </Section>
      </SettingsLayout>
    </main>
  );
}
