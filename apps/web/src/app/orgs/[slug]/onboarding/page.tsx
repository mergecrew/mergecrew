import Link from 'next/link';
import { revalidatePath } from 'next/cache';
import { api } from '@/lib/api';
import { requireSession } from '@/lib/session';
import { Card, LinkButton } from '@/components/ui';
import { InlineLlmStep } from '@/components/onboarding-inline-llm';
import { CreateProjectForm } from '@/components/onboarding/create-project-form';
import { WizardRow, type WizardRowStatus } from '@/components/onboarding/wizard-row';
import { RepoForm } from '../projects/[projectSlug]/settings/repo-form';
import { DeployTargetForm, type DeployTargetRow } from '../projects/[projectSlug]/settings/deploy-target-form';
import { StockTemplatePicker, type StockTemplateSummary } from '@/components/lifecycle/stock-template-picker';

type StepKey =
  | 'llm_provider'
  | 'first_project'
  | 'connected_repo'
  | 'deploy_target'
  | 'lifecycle_template';

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
  lifecycle_template:
    'Pick a stock Planner/Coder/Reviewer setup tuned for your stack (Next.js, Python, Go, or generic). One click installs it as your project lifecycle.',
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
  const [projectDetail, deployTargetsRes, stockTemplatesRes] = projectSlug
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
          api<{ items: StockTemplateSummary[] }>(`/v1/lifecycle-templates/stock`, {
            session,
          }),
        ),
      ])
    : [null, null, null];

  const connectedRepo = projectDetail?.connectedRepo ?? null;
  const deployTargets = deployTargetsRes?.items ?? [];
  const stockTemplates = stockTemplatesRes?.items ?? [];

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

  return (
    <main className="mx-auto max-w-3xl space-y-6 p-6">
      <header className="space-y-2">
        <h1 className="text-2xl font-semibold">Set up your project</h1>
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          mergecrew runs a planner → coder → reviewer chain on your repo each day and proposes
          changesets for approval. Five steps connect an LLM, a repo, and a dev deploy target so
          the agents have somewhere to run.
        </p>
      </header>

      {state.complete && (
        <Card className="border-emerald-200 bg-emerald-50/50 dark:border-emerald-700/40 dark:bg-emerald-950/30">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <div className="font-medium">You&apos;re all set</div>
              <p className="text-sm text-zinc-700 dark:text-zinc-200">
                Trigger your first run from the project page — agents will plan, code, and review against the connected repo.
              </p>
            </div>
            {projectSlug && (
              <LinkButton href={`/orgs/${slug}/projects/${projectSlug}`} variant="primary">
                Go to {projectSlug}
              </LinkButton>
            )}
          </div>
        </Card>
      )}

      <ol className="space-y-3">
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
              case 'lifecycle_template':
                body = projectSlug ? (
                  <StockTemplatePicker
                    scope={{ kind: 'project', orgSlug: slug, projectSlug }}
                    templates={stockTemplates}
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
        <div className="text-center text-sm">
          <Link
            href={`/orgs/${slug}/projects/${demoProject.slug}`}
            className="text-zinc-600 underline hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-200"
          >
            Or skip for now — explore the demo project →
          </Link>
        </div>
      )}
    </main>
  );
}

function BlockedBecauseNoProject() {
  return (
    <p className="rounded border border-dashed p-3 text-sm text-zinc-600 dark:border-zinc-700 dark:text-zinc-300">
      Finish the project-creation step first; this step targets the project you create.
    </p>
  );
}
