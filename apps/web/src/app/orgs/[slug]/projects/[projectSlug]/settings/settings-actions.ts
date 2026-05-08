'use server';

import { revalidatePath } from 'next/cache';
import { api } from '@/lib/api';
import { requireSession } from '@/lib/session';

export async function updateProjectAction(
  slug: string,
  projectSlug: string,
  patch: { name?: string; description?: string | null; archived?: boolean },
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
  },
) {
  const session = await requireSession();
  await api(`/v1/orgs/${slug}/projects/${projectSlug}/connect-repo`, {
    method: 'POST',
    body: JSON.stringify(input),
    session,
  });
  revalidatePath(`/orgs/${slug}/projects/${projectSlug}/settings`);
}

export async function disconnectRepoAction(slug: string, projectSlug: string) {
  const session = await requireSession();
  await api(`/v1/orgs/${slug}/projects/${projectSlug}/connect-repo`, {
    method: 'DELETE',
    session,
  });
  revalidatePath(`/orgs/${slug}/projects/${projectSlug}/settings`);
}
