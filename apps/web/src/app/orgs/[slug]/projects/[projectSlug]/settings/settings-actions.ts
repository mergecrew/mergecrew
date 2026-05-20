'use server';

import { revalidatePath } from 'next/cache';
import { api } from '@/lib/api';
import { requireSession } from '@/lib/session';

export async function updateProjectAction(
  slug: string,
  projectSlug: string,
  patch: {
    name?: string;
    description?: string | null;
    archived?: boolean;
    dryRun?: boolean;
    maxFilesChanged?: number;
    maxLinesChanged?: number;
    deniedPaths?: string[];
    autoMergeThreshold?: number;
    sensitivePaths?: string[];
    graphProfile?: 'fast' | 'careful' | 'custom';
    graphYaml?: string | null;
    egressAllowlist?: string[] | null;
  },
) {
  const session = await requireSession();
  await api(`/v1/orgs/${slug}/projects/${projectSlug}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
    session,
  });
  revalidatePath(`/orgs/${slug}/projects/${projectSlug}/settings`);
  revalidatePath(`/orgs/${slug}/projects/${projectSlug}`);
}

export async function connectRepoAction(
  slug: string,
  projectSlug: string,
  input: {
    repoFullName: string;
    defaultBranch: string;
    installationId: string;
    repoId: string;
    /**
     * Branch mergecrew opens new PRs against (#469). Null / empty
     * coalesces server-side to `defaultBranch` so trunk-based teams
     * keep the prior behavior without an explicit value.
     */
    basePrBranch?: string | null;
  },
) {
  const session = await requireSession();
  await api(`/v1/orgs/${slug}/projects/${projectSlug}/connect-repo`, {
    method: 'POST',
    body: JSON.stringify(input),
    session,
  });
  revalidatePath(`/orgs/${slug}/projects/${projectSlug}/settings`);
  revalidatePath(`/orgs/${slug}/onboarding`);
}

export async function disconnectRepoAction(slug: string, projectSlug: string) {
  const session = await requireSession();
  await api(`/v1/orgs/${slug}/projects/${projectSlug}/connect-repo`, {
    method: 'DELETE',
    session,
  });
  revalidatePath(`/orgs/${slug}/projects/${projectSlug}/settings`);
  revalidatePath(`/orgs/${slug}/onboarding`);
}

/**
 * V1.1 Project Inception (#7): clones the connected repo, runs the
 * `@mergecrew/inception` detector, returns the structured summary +
 * draft `mergecrew.yaml` for the setup wizard to display.
 */
export async function runInceptionAction(slug: string, projectSlug: string) {
  const session = await requireSession();
  return api(`/v1/orgs/${slug}/projects/${projectSlug}/inception`, {
    method: 'POST',
    session,
  });
}

export async function upsertDeployTargetAction(
  slug: string,
  projectSlug: string,
  input: {
    kind: 'dev' | 'staging' | 'prod';
    adapterId: string;
    config: Record<string, unknown>;
  },
) {
  const session = await requireSession();
  await api(`/v1/orgs/${slug}/projects/${projectSlug}/deploy-targets`, {
    method: 'POST',
    body: JSON.stringify(input),
    session,
  });
  revalidatePath(`/orgs/${slug}/projects/${projectSlug}/settings`);
  revalidatePath(`/orgs/${slug}/onboarding`);
}

export async function deleteDeployTargetAction(
  slug: string,
  projectSlug: string,
  kind: 'dev' | 'staging' | 'prod',
) {
  const session = await requireSession();
  await api(`/v1/orgs/${slug}/projects/${projectSlug}/deploy-targets/${kind}`, {
    method: 'DELETE',
    session,
  });
  revalidatePath(`/orgs/${slug}/projects/${projectSlug}/settings`);
  revalidatePath(`/orgs/${slug}/onboarding`);
}

export type PromotionStrategyKind =
  | 'auto_deploy'
  | 'manual_workflow'
  | 'tag_driven'
  | 'single_env'
  | 'deferred';

export interface PromotionStrategyInput {
  kind: PromotionStrategyKind;
  releaseBranch?: string | null;
  workflowFilename?: string | null;
  envInputKey?: string | null;
  envInputValue?: string | null;
  tagPattern?: string | null;
  prodUrl?: string | null;
}

export async function upsertPromotionStrategyAction(
  slug: string,
  projectSlug: string,
  input: PromotionStrategyInput,
) {
  const session = await requireSession();
  await api(`/v1/orgs/${slug}/projects/${projectSlug}/promotion-strategy`, {
    method: 'PUT',
    body: JSON.stringify(input),
    session,
  });
  revalidatePath(`/orgs/${slug}/projects/${projectSlug}/settings`);
  revalidatePath(`/orgs/${slug}/onboarding`);
}

export interface PromoteRunSnapshot {
  id: string;
  status: 'pending' | 'conflict' | 'completed' | 'failed';
  releaseRef: string | null;
  conflict: { changesetId: string; files: string[] } | null;
  failureReason: string | null;
}

export async function promoteAction(
  slug: string,
  projectSlug: string,
  approvedChangesetIds: string[],
): Promise<PromoteRunSnapshot> {
  const session = await requireSession();
  const run = await api<PromoteRunSnapshot>(
    `/v1/orgs/${slug}/projects/${projectSlug}/promote`,
    {
      method: 'POST',
      body: JSON.stringify({ approvedChangesetIds }),
      session,
    },
  );
  revalidatePath(`/orgs/${slug}/projects/${projectSlug}`);
  return run;
}

export async function dropChangesetAction(
  slug: string,
  projectSlug: string,
  csId: string,
): Promise<{ revertPrUrl: string; alreadyDropped: boolean }> {
  const session = await requireSession();
  const r = await api<{ revertPrUrl: string; alreadyDropped: boolean }>(
    `/v1/orgs/${slug}/projects/${projectSlug}/changesets/${csId}/drop`,
    { method: 'POST', session },
  );
  revalidatePath(`/orgs/${slug}/projects/${projectSlug}`);
  return r;
}

/**
 * V1.1 onboarding smoke test (#7): opens a no-op draft PR, dispatches
 * the dev deploy workflow, awaits completion, returns the resulting URL.
 * Long-running (up to 5 min) — the action's transition reflects that.
 */
export async function runSmokeTestAction(slug: string, projectSlug: string) {
  const session = await requireSession();
  return api(`/v1/orgs/${slug}/projects/${projectSlug}/smoke-test`, {
    method: 'POST',
    session,
  });
}
