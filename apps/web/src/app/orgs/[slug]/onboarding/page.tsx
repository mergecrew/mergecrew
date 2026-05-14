import Link from 'next/link';
import { revalidatePath } from 'next/cache';
import { Check, ChevronRight, Circle } from 'lucide-react';
import clsx from 'clsx';
import { api } from '@/lib/api';
import { requireSession } from '@/lib/session';
import { Card, LinkButton } from '@/components/ui';
import { InlineLlmStep } from '@/components/onboarding-inline-llm';

interface OnboardingStep {
  key:
    | 'llm_provider'
    | 'first_project'
    | 'connected_repo'
    | 'deploy_target'
    | 'lifecycle_template';
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
const STEP_HELP: Record<OnboardingStep['key'], string> = {
  llm_provider:
    'Pick a provider (Anthropic, OpenAI, AWS Bedrock, or Ollama) and paste an API key. Without one, agent steps fail with "no LLM profile configured".',
  first_project:
    'A project is the unit a daily run targets. Each project has its own repo, deploy target, lifecycle, and changeset list.',
  connected_repo:
    'Mergecrew opens its PRs here. The bundled GitHub adapter handles app install + repo selection; pick "local" for a synthetic walkthrough.',
  deploy_target:
    'The dev target is where the agent\'s changesets get deployed for human review before prod. Use `local-noop` if you just want to see the loop and skip real deploys.',
  lifecycle_template:
    'Pick a stock Planner/Coder/Reviewer setup tuned for your stack (Next.js, Python, Go, or generic). One click installs it as your project lifecycle — you can still edit the YAML after.',
};

async function addLlmProviderAction(formData: FormData) {
  'use server';
  const slug = String(formData.get('slug') ?? '');
  const kind = String(formData.get('kind') ?? '') as 'anthropic' | 'openai' | 'bedrock' | 'ollama';
  const apiKey = String(formData.get('apiKey') ?? '').trim();
  const endpoint = String(formData.get('endpoint') ?? '').trim();
  if (!slug || !kind) return;
  // Ollama is the only kind where the operator can skip the API key
  // (the endpoint URL is the credential). Other kinds need a non-empty
  // apiKey or the create will server-side-reject.
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
  // Refresh the wizard page so the step flips from pending → complete.
  revalidatePath(`/orgs/${slug}/onboarding`);
}

export default async function OnboardingPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const session = await requireSession();
  const [state, projects] = await Promise.all([
    api<OnboardingState>(`/v1/orgs/${slug}/onboarding`, { session }),
    api<{ items: Array<{ slug: string; demo: boolean }> }>(`/v1/orgs/${slug}/projects`, {
      session,
    }).catch(() => ({ items: [] as Array<{ slug: string; demo: boolean }> })),
  ]);

  const demoProject = projects.items.find((p) => p.demo) ?? null;
  const activeIndex = state.steps.findIndex((s) => s.status === 'pending');

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
          <div className="flex items-center justify-between gap-4">
            <div>
              <div className="font-medium">You&apos;re all set</div>
              <p className="text-sm text-zinc-700 dark:text-zinc-200">
                Trigger your first run from the project page — agents will plan, code, and review against the connected repo.
              </p>
            </div>
            <LinkButton href={`/orgs/${slug}`}>Back to Today</LinkButton>
          </div>
        </Card>
      )}

      <ol className="space-y-3">
        {state.steps.map((step, i) => {
          const isComplete = step.status === 'complete';
          const isActive = i === activeIndex;
          // The LLM step is the only one with an inline form (#385) —
          // the others (project / repo / deploy target) need richer
          // settings UIs that already live on dedicated pages.
          const inlineLlm = step.key === 'llm_provider' && isActive && !isComplete;
          const stepBody = (
            <div className="flex items-start gap-4">
              <div className="mt-0.5 shrink-0">
                {isComplete ? (
                  <Check className="h-5 w-5 text-emerald-600 dark:text-emerald-400" aria-label="complete" />
                ) : (
                  <Circle
                    className={clsx(
                      'h-5 w-5',
                      isActive
                        ? 'text-sky-600 dark:text-sky-400'
                        : 'text-zinc-400 dark:text-zinc-500',
                    )}
                    aria-label={isActive ? 'active' : 'pending'}
                  />
                )}
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center justify-between gap-2">
                  <span
                    className={clsx(
                      'font-medium',
                      isComplete && 'line-through decoration-zinc-300 dark:decoration-zinc-600',
                    )}
                  >
                    Step {i + 1} · {step.label}
                  </span>
                  {!isComplete && !inlineLlm && (
                    <ChevronRight className="h-4 w-4 shrink-0 text-zinc-400" aria-hidden />
                  )}
                </div>
                <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
                  {STEP_HELP[step.key]}
                </p>
                {inlineLlm && (
                  <div className="mt-3">
                    <InlineLlmStep orgSlug={slug} action={addLlmProviderAction} />
                  </div>
                )}
              </div>
            </div>
          );
          const wrapperClass = clsx(
            'block rounded-lg border p-4 shadow-sm transition-colors',
            isActive
              ? 'border-sky-400 bg-sky-50/60 dark:border-sky-600 dark:bg-sky-950/30'
              : 'border-zinc-200 bg-[rgb(var(--card))] dark:border-zinc-700',
            isComplete && 'opacity-75',
            !inlineLlm && !isComplete && 'hover:bg-sky-50 dark:hover:bg-sky-950/40',
            !inlineLlm && isComplete && 'hover:border-zinc-300 dark:hover:border-zinc-600',
          );
          return (
            <li key={step.key}>
              {inlineLlm ? (
                <div className={wrapperClass}>{stepBody}</div>
              ) : (
                <Link href={step.actionUrl} className={wrapperClass}>
                  {stepBody}
                </Link>
              )}
            </li>
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
