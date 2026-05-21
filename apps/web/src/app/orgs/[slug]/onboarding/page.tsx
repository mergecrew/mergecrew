import Link from 'next/link';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { api } from '@/lib/api';
import { requireSession } from '@/lib/session';
import { Card, Label, PageHead } from '@/components/ui';
import { TopBar } from '@/components/shell/topbar';
import { UserMenu } from '@/components/user-menu';
import { InlineLlmStep } from '@/components/onboarding-inline-llm';
import { CreateProjectForm } from '@/components/onboarding/create-project-form';
import { SeedGoalCard } from '@/components/onboarding/seed-goal-card';
import { WizardRow, type WizardRowStatus } from '@/components/onboarding/wizard-row';
import { RepoForm } from '../projects/[projectSlug]/settings/repo-form';
import { DeployTargetForm, type DeployTargetRow } from '../projects/[projectSlug]/settings/deploy-target-form';
import {
  PromotionStrategyForm,
  type PromotionStrategy,
} from '../projects/[projectSlug]/settings/promotion-strategy-form';
type StepKey =
  | 'llm_provider'
  | 'first_project'
  | 'connected_repo'
  | 'deploy_target'
  | 'promotion_strategy';

interface OnboardingStep {
  key: StepKey;
  label: string;
  status: 'complete' | 'pending';
  actionUrl: string;
}
interface OnboardingState {
  steps: OnboardingStep[];
  complete: boolean;
}

// Human-readable why-this-matters lines per step. Kept here rather than
// on the API response because the copy is UI-shaped and changes
// independently of the underlying state computation.
const STEP_HELP: Record<StepKey, string> = {
  llm_provider:
    'Pick a provider (Anthropic, OpenAI, AWS Bedrock, or Ollama) and paste an API key. Without one, agent steps fail with "no LLM profile configured".',
  first_project:
    'A project is the unit a daily run targets. Each project has its own repo, deploy target, lifecycle, and changeset list.',
  connected_repo:
    'Mergecrew opens its PRs here. The bundled GitHub adapter handles app install + repo selection; pick "local" for a synthetic walkthrough.',
  deploy_target:
    "Where merged PRs land. Most teams already have CI/CD wired up — paste the URL it deploys to and we're done. Need a different adapter (Vercel, Netlify, GitHub Actions dispatch, …)? Switch in project settings later.",
  promotion_strategy:
    "How does dev graduate to prod? Pick the shape that matches your existing pipeline. The cookbook has a worked example for each — link beside every option.",
};

interface ProjectListItem {
  slug: string;
  demo: boolean;
}

interface ProjectDetail {
  slug: string;
  demo: boolean;
  connectedRepo: {
    repoFullName: string;
    defaultBranch: string;
    installationId: string;
    repoId: string;
    basePrBranch: string | null;
  } | null;
}

interface AvailableRepo {
  repoId: string;
  repoFullName: string;
  defaultBranch: string;
  private: boolean;
}

async function safe<T>(fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch {
    return null;
  }
}

async function addLlmProviderAction(formData: FormData) {
  'use server';
  const slug = String(formData.get('slug') ?? '');
  const kind = String(formData.get('kind') ?? '') as
    | 'anthropic'
    | 'openai'
    | 'bedrock'
    | 'ollama';
  const apiKey = String(formData.get('apiKey') ?? '').trim();
  const endpoint = String(formData.get('endpoint') ?? '').trim();
  if (!slug || !kind) return;
  // Ollama is the only kind where the operator can skip the API key
  // (the endpoint URL is the credential).
  if (kind !== 'ollama' && !apiKey) return;
  const session = await requireSession();
  await api(`/v1/orgs/${slug}/llm/providers`, {
    method: 'POST',
    body: JSON.stringify({
      kind,
      label: kind === 'ollama' ? 'Ollama (local)' : `${kind} (added via wizard)`,
      ...(apiKey ? { apiKey } : {}),
      ...(endpoint ? { endpoint } : {}),
    }),
    session,
  }).catch(() => undefined);
  revalidatePath(`/orgs/${slug}/onboarding`);
}

async function createFirstProjectAction(formData: FormData) {
  'use server';
  const slug = String(formData.get('orgSlug') ?? '');
  const name = String(formData.get('name') ?? '').trim();
  const projectSlug = String(formData.get('slug') ?? '').trim();
  if (!slug || !name || !projectSlug) return;
  const session = await requireSession();
  await api(`/v1/orgs/${slug}/projects`, {
    method: 'POST',
    body: JSON.stringify({ name, slug: projectSlug }),
    session,
  }).catch(() => undefined);
  // Stay on the wizard — next step expands inline after revalidation.
  revalidatePath(`/orgs/${slug}/onboarding`);
}

// Seed-goal capture (#493). Final wizard step: short free-form
// description of what mergecrew should work on first. Persisted as a
// queued IntentInboxItem so the planner picks it up on the next run
// (see `synthesizeAgentInput` in apps/runner/src/step.ts) and produces
// a real plan instead of asking the LLM "what would you like me to
// do?". A "Save and run" click also fires the manual run so the
// operator sees output immediately; we redirect to the run-detail
// page so the timeline streams in front of them.
async function createSeedGoalAndRunAction(formData: FormData) {
  'use server';
  const slug = String(formData.get('orgSlug') ?? '');
  const projectSlug = String(formData.get('projectSlug') ?? '').trim();
  const goal = String(formData.get('goal') ?? '').trim();
  if (!slug || !projectSlug || !goal) return;
  const session = await requireSession();
  await api(`/v1/orgs/${slug}/projects/${projectSlug}/intent-inbox`, {
    method: 'POST',
    body: JSON.stringify({ body: goal }),
    session,
  }).catch(() => undefined);
  const r = await api<{ runId: string }>(
    `/v1/orgs/${slug}/projects/${projectSlug}/runs`,
    { method: 'POST', body: JSON.stringify({}), session },
  ).catch(() => null);
  if (r?.runId) {
    redirect(`/orgs/${slug}/projects/${projectSlug}/runs/${r.runId}`);
  }
  redirect(`/orgs/${slug}/projects/${projectSlug}`);
}

export default async function OnboardingPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { slug } = await params;
  const sp = (await searchParams) ?? {};
  const installedInstallationId =
    sp.from === 'github_install' && typeof sp.installation_id === 'string'
      ? sp.installation_id
      : null;
  const session = await requireSession();
  const [state, projects] = await Promise.all([
    api<OnboardingState>(`/v1/orgs/${slug}/onboarding`, { session }),
    api<{ items: ProjectListItem[] }>(`/v1/orgs/${slug}/projects`, { session }).catch(
      () => ({ items: [] as ProjectListItem[] }),
    ),
  ]);

  const demoProject = projects.items.find((p) => p.demo) ?? null;
  const firstProject = projects.items.find((p) => !p.demo) ?? null;
  const projectSlug = firstProject?.slug ?? null;

  // Fan-out for the active project's downstream data. Done in parallel
  // so the wizard renders without waterfall latency once a project
  // exists. Stock templates are fetched whenever a project exists; the
  // installation-repos endpoint only when we have an installation id
  // (either from the GitHub round-trip query or from a saved connected
  // repo).
  const [projectDetail, deployTargetsRes, promotionStrategy] = projectSlug
    ? await Promise.all([
        safe(() =>
          api<ProjectDetail>(`/v1/orgs/${slug}/projects/${projectSlug}`, { session }),
        ),
        safe(() =>
          api<{ items: DeployTargetRow[] }>(
            `/v1/orgs/${slug}/projects/${projectSlug}/deploy-targets`,
            { session },
          ),
        ),
        safe(() =>
          api<PromotionStrategy | null>(
            `/v1/orgs/${slug}/projects/${projectSlug}/promotion-strategy`,
            { session },
          ),
        ),
      ])
    : [null, null, null];

  const connectedRepo = projectDetail?.connectedRepo ?? null;
  const deployTargets = deployTargetsRes?.items ?? [];

  const lookupInstallationId =
    installedInstallationId ?? connectedRepo?.installationId ?? null;
  let availableRepos: AvailableRepo[] = [];
  if (projectSlug && lookupInstallationId) {
    const r = await safe(() =>
      api<{ items: AvailableRepo[] }>(
        `/v1/orgs/${slug}/projects/${projectSlug}/installation-repos/${encodeURIComponent(lookupInstallationId)}`,
        { session },
      ),
    );
    availableRepos = r?.items ?? [];
  }

  const activeIndex = state.steps.findIndex((s) => s.status === 'pending');
  const rowStatus = (i: number): WizardRowStatus =>
    i < activeIndex || activeIndex === -1
      ? 'complete'
      : i === activeIndex
        ? 'active'
        : 'locked';

  const completedCount = state.steps.filter((s) => s.status === 'complete').length;
  const totalCount = state.steps.length;
  const activeLabel =
    activeIndex === -1
      ? 'Complete'
      : `${completedCount} of ${totalCount} · ${state.steps[activeIndex]?.label ?? ''}`;

  return (
    <div className="min-h-screen bg-bg text-ink">
      <TopBar orgSlug={slug} userMenu={<UserMenu currentOrgSlug={slug} />} />
      <main className="mx-auto max-w-[860px] px-9 py-9">
        <PageHead
          crumb={[
            { label: slug, href: `/orgs/${slug}` },
            { label: 'Onboarding' },
          ]}
          title="Set up your project"
          meta={
            <span className="font-mono text-[12.5px] text-muted">
              mergecrew runs a Planner → Coder → Reviewer chain on your repo each weekday and
              proposes changesets for approval. Five steps connect an LLM, a repo, and a dev deploy
              target so the agents have somewhere to run.
            </span>
          }
          actions={<Label accent>{activeLabel}</Label>}
        />

        {state.complete && projectSlug && (
          <div className="mb-6">
            <SeedGoalCard
              orgSlug={slug}
              projectSlug={projectSlug}
              action={createSeedGoalAndRunAction}
            />
          </div>
        )}
        {state.complete && !projectSlug && (
          <Card className="mb-6 border-positive bg-positive-soft p-5">
            <div className="font-medium text-positive-deep">You&apos;re all set</div>
            <p className="mt-1 text-[13.5px] text-ink-2">
              Setup complete. Visit the project page to trigger a run.
            </p>
          </Card>
        )}

        <ol className="space-y-3 list-none p-0 m-0">
          {state.steps.map((step, i) => {
            const status = rowStatus(i);
            const description = status === 'active' ? STEP_HELP[step.key] : undefined;
            let body: React.ReactNode = null;
            if (status === 'active') {
              switch (step.key) {
                case 'llm_provider':
                  body = <InlineLlmStep orgSlug={slug} action={addLlmProviderAction} />;
                  break;
                case 'first_project':
                  body = (
                    <CreateProjectForm orgSlug={slug} action={createFirstProjectAction} />
                  );
                  break;
                case 'connected_repo':
                  body = projectSlug ? (
                    <RepoForm
                      slug={slug}
                      projectSlug={projectSlug}
                      initial={connectedRepo}
                      installedInstallationId={installedInstallationId}
                      availableRepos={availableRepos}
                      installFrom="wizard"
                    />
                  ) : (
                    <BlockedBecauseNoProject />
                  );
                  break;
                case 'deploy_target':
                  body = projectSlug ? (
                    <DeployTargetForm
                      slug={slug}
                      projectSlug={projectSlug}
                      initial={deployTargets}
                      kinds={['dev']}
                      installFrom="wizard"
                      baseBranch={
                        connectedRepo?.basePrBranch?.trim() ||
                        connectedRepo?.defaultBranch
                      }
                    />
                  ) : (
                    <BlockedBecauseNoProject />
                  );
                  break;
                case 'promotion_strategy':
                  body = projectSlug ? (
                    <PromotionStrategyForm
                      slug={slug}
                      projectSlug={projectSlug}
                      orgSlug={slug}
                      initial={promotionStrategy}
                      defaultReleaseBranch={
                        connectedRepo?.basePrBranch?.trim() ||
                        connectedRepo?.defaultBranch
                      }
                    />
                  ) : (
                    <BlockedBecauseNoProject />
                  );
                  break;
              }
            }
            return (
              <WizardRow
                key={step.key}
                index={i}
                label={step.label}
                status={status}
                description={description}
              >
                {body}
              </WizardRow>
            );
          })}
        </ol>

        {demoProject && !state.complete && (
          <div className="mt-6 text-center text-sm">
            <Link
              href={`/orgs/${slug}/projects/${demoProject.slug}`}
              className="text-ink-2 underline-offset-[3px] hover:text-accent hover:underline"
            >
              Or skip for now — explore the demo project →
            </Link>
          </div>
        )}
      </main>
    </div>
  );
}

function BlockedBecauseNoProject() {
  return (
    <p className="border border-dashed border-hair p-3 text-[13px] text-ink-2">
      Finish the project-creation step first; this step targets the project you create.
    </p>
  );
}
